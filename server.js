import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import pkg from "pg";
import nodemailer from "nodemailer";
import crypto from "crypto";
import dns from "dns";

// Force IPv4 for all DNS lookups (Railway can't reach IPv6)
dns.setDefaultResultOrder("ipv4first");

dotenv.config();

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

// -------------------------------
// OpenAI
// -------------------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// -------------------------------
// DB
// -------------------------------
const pool = new Pool({
  connectionString: process.env.DB_URL,
  ssl: { rejectUnauthorized: false }
});

// -------------------------------
// EMAIL
// -------------------------------
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// -------------------------------
// TENANT VALIDATION HELPER
// -------------------------------
async function validateTenant(tenantId) {
  if (!tenantId) return null;

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(tenantId)) return null;

  const result = await pool.query(
    `SELECT id, name FROM tenants WHERE id = $1 AND is_active = TRUE`,
    [tenantId]
  );

  return result.rows.length > 0 ? result.rows[0] : null;
}

// -------------------------------
// MAIN API
// -------------------------------
app.post("/analyze-invoice", async (req, res) => {

  const invoice = req.body;

  try {

    console.log("Incoming Invoice:", invoice);

    // -------------------------------
    // TENANT CHECK
    // -------------------------------
    const tenantId = invoice.tenant_id;

    const tenant = await validateTenant(tenantId);
    if (!tenant) {
      return res.status(400).json({ error: "Missing or invalid tenant_id" });
    }

    // -------------------------------
    // Vendor History (tenant-scoped)
    // -------------------------------
    const vendorHistory = await pool.query(
      `SELECT AVG(amount) as avg_amount, COUNT(*) as total_invoices
       FROM invoices WHERE vendor=$1 AND tenant_id=$2`,
      [invoice.vendor, tenantId]
    );

    const avgAmount = parseFloat(vendorHistory.rows[0].avg_amount) || 0;
    const totalInvoices = parseInt(vendorHistory.rows[0].total_invoices) || 0;

    // -------------------------------
    // Duplicate Check (tenant-scoped)
    // -------------------------------
    const duplicateCheck = await pool.query(
      `SELECT * FROM invoices
       WHERE vendor=$1 AND amount=$2 AND tenant_id=$3
       AND invoice_date > NOW() - interval '30 days'`,
      [invoice.vendor, invoice.amount, tenantId]
    );

    const possibleDuplicate = duplicateCheck.rows.length > 0;

    // -------------------------------
    // OpenAI Decision
    // -------------------------------
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are a financial controller.

Return ONLY valid JSON.

Format:
{
  "confidence": number (0-1),
  "action": "approve" | "review" | "reject",
  "reasoning": "string"
}

Vendor avg: ${avgAmount}
Duplicate: ${possibleDuplicate}
`
        },
        {
          role: "user",
          content: JSON.stringify(invoice)
        }
      ],
      temperature: 0
    });

    // -------------------------------
    // SAFE PARSING
    // -------------------------------
    let resultText = response.choices[0].message.content.trim();

    resultText = resultText
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    let result;

    try {
      result = JSON.parse(resultText);
    } catch {
      console.log("⚠️ JSON parse failed → fallback");

      result = {
        confidence: 0.6,
        action: "review",
        reasoning: resultText
      };
    }

    // -------------------------------
    // CONFIDENCE FIX
    // -------------------------------
    let confidenceScore = typeof result.confidence === "number" ? result.confidence : 0.6;

    let confidenceLevel =
      confidenceScore >= 0.8 ? "high" :
      confidenceScore >= 0.5 ? "medium" : "low";

    // -------------------------------
    // HARD RULES
    // -------------------------------
    if (possibleDuplicate) {
      result.action = "reject";
      result.reasoning = "Duplicate invoice detected";
    }

    if (avgAmount > 0 && invoice.amount > 3 * avgAmount) {
      result.action = "review";
      result.reasoning = "Amount exceeds vendor average";
    }

    console.log("Final Decision:", result);

    // -------------------------------
    // TOKEN GENERATION 🔐
    // -------------------------------
    const token = crypto.randomBytes(32).toString("hex");

    // -------------------------------
    // APPROVER EMAIL
    // -------------------------------
    const approver = invoice.approver_email || process.env.EMAIL_USER;

    // -------------------------------
    // SAVE INVOICE (tenant-scoped)
    // -------------------------------
    await pool.query(
      `INSERT INTO invoices
      (invoice_id, vendor, amount, department, invoice_date,
       decision, confidence, confidence_score, reasoning,
       approval_status, approval_token, token_expiry, approved_by,
       tenant_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW() + interval '1 hour', $12, $13)`,
      [
        invoice.invoice_id,
        invoice.vendor,
        invoice.amount,
        invoice.department,
        invoice.date,
        result.action,
        confidenceLevel,
        confidenceScore,
        result.reasoning,
        "pending",
        token,
        approver,
        tenantId
      ]
    );

    // -------------------------------
    // AUDIT LOG (tenant-scoped)
    // -------------------------------
    await pool.query(
      `INSERT INTO audit_log (event, metadata, tenant_id)
       VALUES ($1, $2, $3)`,
      [
        "invoice_analyzed",
        JSON.stringify({
          invoice_id: invoice.invoice_id,
          vendor: invoice.vendor,
          amount: invoice.amount,
          decision: result.action,
          confidence: confidenceLevel
        }),
        tenantId
      ]
    );

    // -------------------------------
    // RESPOND IMMEDIATELY (don't wait for email)
    // -------------------------------
    res.json({
      message: "Invoice processed",
      tenant: tenant.name,
      decision: result.action,
      confidence: confidenceLevel
    });

    // -------------------------------
    // EMAIL (fire-and-forget, non-blocking)
    // -------------------------------
    const approveUrl = `http://localhost:3000/approve?token=${token}`;
    const rejectUrl = `http://localhost:3000/reject?token=${token}`;

    transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: approver,
      subject: `Invoice Approval — ${tenant.name}`,
      html: `
        <h2>Invoice Approval Needed</h2>
        <p><b>Company:</b> ${tenant.name}</p>
        <p><b>Vendor:</b> ${invoice.vendor}</p>
        <p><b>Amount:</b> ${invoice.amount}</p>
        <p><b>AI Decision:</b> ${result.action}</p>

        <a href="${approveUrl}">Approve</a><br/><br/>
        <a href="${rejectUrl}">Reject</a>

        <p>This link expires in 1 hour</p>
      `
    }).then(() => {
      console.log("Email sent to:", approver);
    }).catch((emailErr) => {
      console.error("Email failed (non-blocking):", emailErr.message);
    });

  } catch (error) {
    console.error("ACA Error:", error);
    res.status(500).send(error.message);
  }
});

// -------------------------------
// APPROVE (SECURE)
// -------------------------------
app.get("/approve", async (req, res) => {

  const { token } = req.query;

  if (!token) {
    return res.send("Missing token ❌");
  }

  const result = await pool.query(
    `SELECT * FROM invoices 
     WHERE approval_token=$1
     AND token_expiry > NOW()`,
    [token]
  );

  if (result.rows.length === 0) {
    return res.send("Invalid or Expired token ❌");
  }

  const invoice = result.rows[0];

  await pool.query(
    `UPDATE invoices
     SET approval_status='approved',
         approved_at=NOW()
     WHERE approval_token=$1`,
    [token]
  );

  await pool.query(
    `INSERT INTO audit_log (event, metadata, tenant_id)
     VALUES ($1, $2, $3)`,
    [
      "invoice_approved",
      JSON.stringify({
        invoice_id: invoice.invoice_id,
        approved_by: invoice.approved_by
      }),
      invoice.tenant_id
    ]
  );

  res.send("✅ Approved securely");
});

// -------------------------------
// REJECT (SECURE)
// -------------------------------
app.get("/reject", async (req, res) => {

  const { token } = req.query;

  if (!token) {
    return res.send("Missing token ❌");
  }

  const result = await pool.query(
    `SELECT * FROM invoices 
     WHERE approval_token=$1
     AND token_expiry > NOW()`,
    [token]
  );

  if (result.rows.length === 0) {
    return res.send("Invalid or Expired token ❌");
  }

  const invoice = result.rows[0];

  await pool.query(
    `UPDATE invoices
     SET approval_status='rejected',
         approved_at=NOW()
     WHERE approval_token=$1`,
    [token]
  );

  await pool.query(
    `INSERT INTO audit_log (event, metadata, tenant_id)
     VALUES ($1, $2, $3)`,
    [
      "invoice_rejected",
      JSON.stringify({
        invoice_id: invoice.invoice_id,
        rejected_by: invoice.approved_by
      }),
      invoice.tenant_id
    ]
  );

  res.send("❌ Rejected securely");
});

// -------------------------------
app.get("/", (req, res) => {
  res.send("Secure ACA Agent Running");
});

// -------------------------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Secure ACA running on port ${PORT}`);
});
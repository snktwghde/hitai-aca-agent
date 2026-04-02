import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import pkg from "pg";
import crypto from "crypto";
import dns from "dns";
import { Resend } from "resend";

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
// EMAIL (Resend — HTTP-based, no SMTP)
// -------------------------------
const resend = new Resend(process.env.RESEND_API_KEY);

// ===============================
// HELPER: TENANT VALIDATION
// ===============================
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

// ===============================
// HELPER: AMOUNT BUCKET
// ===============================
function getAmountBucket(amount) {
  if (amount < 10000) return "under_10k";
  if (amount < 50000) return "10k_50k";
  if (amount < 100000) return "50k_100k";
  if (amount < 500000) return "100k_500k";
  return "over_500k";
}

// ===============================
// HELPER: BUCKET TO AMOUNT RANGE (for rule suggestions)
// ===============================
function bucketToAmountRange(bucket) {
  const ranges = {
    "under_10k": { max_amount: 10000 },
    "10k_50k": { min_amount: 10000, max_amount: 50000 },
    "50k_100k": { min_amount: 50000, max_amount: 100000 },
    "100k_500k": { min_amount: 100000, max_amount: 500000 },
    "over_500k": { min_amount: 500000 }
  };
  return ranges[bucket] || {};
}

// ===============================
// INTELLIGENCE: GET OR CREATE VENDOR SCORE
// ===============================
async function getOrCreateVendorScore(tenantId, vendorName) {
  const existing = await pool.query(
    `SELECT * FROM vendor_scores WHERE tenant_id = $1 AND vendor_name = $2`,
    [tenantId, vendorName]
  );

  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  // New vendor — insert with defaults (reliability 50, no history)
  const inserted = await pool.query(
    `INSERT INTO vendor_scores (tenant_id, vendor_name)
     VALUES ($1, $2)
     RETURNING *`,
    [tenantId, vendorName]
  );

  return inserted.rows[0];
}

// ===============================
// INTELLIGENCE: UPDATE VENDOR SCORE AFTER INVOICE
// ===============================
async function updateVendorScoreOnInvoice(tenantId, vendorName, amount) {
  // Recalculate from actual invoice data for accuracy
  const stats = await pool.query(
    `SELECT COUNT(*) as total, AVG(amount) as avg_amt
     FROM invoices WHERE vendor = $1 AND tenant_id = $2`,
    [vendorName, tenantId]
  );

  const total = parseInt(stats.rows[0].total) || 0;
  const avgAmt = parseFloat(stats.rows[0].avg_amt) || amount;

  await pool.query(
    `UPDATE vendor_scores
     SET total_invoices = $3,
         avg_amount = $4,
         last_updated = NOW()
     WHERE tenant_id = $1 AND vendor_name = $2`,
    [tenantId, vendorName, total, avgAmt]
  );
}

// ===============================
// INTELLIGENCE: UPDATE VENDOR SCORE ON APPROVAL/REJECTION
// ===============================
async function updateVendorScoreOnApproval(tenantId, vendorName, decision) {
  // Recalculate approved/rejected counts from actual data
  const counts = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE approval_status = 'approved') as approved,
       COUNT(*) FILTER (WHERE approval_status = 'rejected') as rejected
     FROM invoices WHERE vendor = $1 AND tenant_id = $2`,
    [vendorName, tenantId]
  );

  const approved = parseInt(counts.rows[0].approved) || 0;
  const rejected = parseInt(counts.rows[0].rejected) || 0;
  const total = approved + rejected;

  // Reliability score: percentage of approved invoices, scaled 0-100
  // Weighted: starts moving meaningfully after 3+ decisions
  let reliability = 50; // default
  if (total >= 1) {
    const rawRatio = approved / total; // 0 to 1
    // Blend toward 50 for small sample sizes (Bayesian-ish smoothing)
    const weight = Math.min(total / 5, 1); // full weight at 5+ decisions
    reliability = Math.round((rawRatio * weight + 0.5 * (1 - weight)) * 100);
  }

  // Dispute rate: rejected / total
  const disputeRate = total > 0 ? (rejected / total) : 0;

  await pool.query(
    `UPDATE vendor_scores
     SET total_approved = $3,
         total_rejected = $4,
         reliability_score = $5,
         dispute_rate = $6,
         last_updated = NOW()
     WHERE tenant_id = $1 AND vendor_name = $2`,
    [tenantId, vendorName, approved, rejected, reliability, disputeRate]
  );
}

// ===============================
// INTELLIGENCE: RULES ENGINE
// ===============================
async function evaluateRules(tenantId, invoice, vendorScore, possibleDuplicate) {
  // Load active rules for this tenant, ordered by priority (lowest first = highest priority)
  const rulesResult = await pool.query(
    `SELECT * FROM tenant_rules
     WHERE tenant_id = $1 AND is_active = TRUE
     ORDER BY priority ASC`,
    [tenantId]
  );

  const rules = rulesResult.rows;
  if (rules.length === 0) return null;

  const amount = parseFloat(invoice.amount);

  for (const rule of rules) {
    const c = rule.conditions;
    let match = true;

    // Check each condition — ALL must be true for the rule to fire

    // Vendor exact match
    if (c.vendor && c.vendor.toLowerCase() !== invoice.vendor.toLowerCase()) {
      match = false;
    }

    // Amount range
    if (c.min_amount !== undefined && amount < c.min_amount) {
      match = false;
    }
    if (c.max_amount !== undefined && amount > c.max_amount) {
      match = false;
    }

    // Department match
    if (c.department && c.department.toLowerCase() !== (invoice.department || "").toLowerCase()) {
      match = false;
    }

    // Vendor must be known (exists in vendor_scores with history)
    if (c.is_known_vendor === true && (!vendorScore || vendorScore.total_invoices === 0)) {
      match = false;
    }

    // Vendor reliability score minimum
    if (c.vendor_score_min !== undefined) {
      if (!vendorScore || parseFloat(vendorScore.reliability_score) < c.vendor_score_min) {
        match = false;
      }
    }

    // Duplicate flag
    if (c.is_duplicate === true && !possibleDuplicate) {
      match = false;
    }

    if (match) {
      console.log(`Rule matched: "${rule.rule_name}" (priority ${rule.priority}) → ${rule.action}`);
      return {
        action: rule.action,
        reasoning: `Deterministic rule: ${rule.rule_name}`,
        ruleId: rule.id,
        ruleName: rule.rule_name
      };
    }
  }

  return null; // No rule matched — proceed to LLM
}

// ===============================
// INTELLIGENCE: RECORD PREDICTION
// ===============================
async function recordPrediction(tenantId, invoiceId, invoiceDbId, predictedAction, confidenceScore, source, ruleId) {
  await pool.query(
    `INSERT INTO prediction_confidence
     (tenant_id, invoice_id, invoice_db_id, predicted_action, confidence_score, decision_source, rule_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, invoiceId, invoiceDbId, predictedAction, confidenceScore, source, ruleId || null]
  );
}

// ===============================
// INTELLIGENCE: CLOSE PREDICTION (on human approval/rejection)
// ===============================
async function closePrediction(tenantId, invoiceId, actualOutcome) {
  const pred = await pool.query(
    `SELECT id, predicted_action FROM prediction_confidence
     WHERE tenant_id = $1 AND invoice_id = $2 AND actual_outcome IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [tenantId, invoiceId]
  );

  if (pred.rows.length === 0) return;

  const prediction = pred.rows[0];
  const wasCorrect = (
    (prediction.predicted_action === "approve" && actualOutcome === "approved") ||
    (prediction.predicted_action === "reject" && actualOutcome === "rejected") ||
    (prediction.predicted_action === "review" && (actualOutcome === "approved" || actualOutcome === "rejected"))
  );

  await pool.query(
    `UPDATE prediction_confidence
     SET actual_outcome = $1, was_correct = $2, feedback_timestamp = NOW()
     WHERE id = $3`,
    [actualOutcome, wasCorrect, prediction.id]
  );
}

// ===============================
// INTELLIGENCE: UPDATE APPROVAL PATTERN
// ===============================
async function updateApprovalPattern(tenantId, approverEmail, vendorName, amount, decision) {
  const bucket = getAmountBucket(amount);

  // Upsert: increment count if pattern exists, insert if new
  await pool.query(
    `INSERT INTO approval_patterns
     (tenant_id, approver_email, vendor_name, amount_bucket, decision, occurrence_count, last_observed)
     VALUES ($1, $2, $3, $4, $5, 1, NOW())
     ON CONFLICT (tenant_id, approver_email, vendor_name, amount_bucket, decision)
     DO UPDATE SET
       occurrence_count = approval_patterns.occurrence_count + 1,
       last_observed = NOW()`,
    [tenantId, approverEmail, vendorName, bucket, decision]
  );

  // Recalculate confidence for this approver+vendor+bucket combo
  const totals = await pool.query(
    `SELECT decision, occurrence_count
     FROM approval_patterns
     WHERE tenant_id = $1 AND approver_email = $2 AND vendor_name = $3 AND amount_bucket = $4`,
    [tenantId, approverEmail, vendorName, bucket]
  );

  const totalCount = totals.rows.reduce((sum, r) => sum + r.occurrence_count, 0);

  for (const row of totals.rows) {
    const conf = totalCount > 0 ? row.occurrence_count / totalCount : 0.5;
    await pool.query(
      `UPDATE approval_patterns SET confidence = $1
       WHERE tenant_id = $2 AND approver_email = $3 AND vendor_name = $4
       AND amount_bucket = $5 AND decision = $6`,
      [conf, tenantId, approverEmail, vendorName, bucket, row.decision]
    );
  }
}

// ===============================
// INTELLIGENCE: GENERATE RULE SUGGESTIONS
// ===============================
async function generateRuleSuggestions(tenantId) {
  // Find patterns where: decision=approved, occurrence_count >= 3, confidence >= 0.85
  const patterns = await pool.query(
    `SELECT ap.approver_email, ap.vendor_name, ap.amount_bucket, ap.occurrence_count, ap.confidence
     FROM approval_patterns ap
     WHERE ap.tenant_id = $1
       AND ap.decision = 'approved'
       AND ap.occurrence_count >= 3
       AND ap.confidence >= 0.85
     ORDER BY ap.occurrence_count DESC`,
    [tenantId]
  );

  if (patterns.rows.length === 0) return [];

  // Load existing rules to avoid suggesting duplicates
  const existingRules = await pool.query(
    `SELECT conditions FROM tenant_rules
     WHERE tenant_id = $1 AND is_active = TRUE AND action = 'approve'`,
    [tenantId]
  );

  const suggestions = [];

  for (const pattern of patterns.rows) {
    // Check if a rule already covers this vendor
    const alreadyCovered = existingRules.rows.some(rule => {
      const c = rule.conditions;
      if (c.vendor && c.vendor.toLowerCase() === pattern.vendor_name.toLowerCase()) return true;
      return false;
    });

    if (alreadyCovered) continue;

    // Get the vendor's current reliability score
    const vendorScore = await pool.query(
      `SELECT reliability_score FROM vendor_scores
       WHERE tenant_id = $1 AND vendor_name = $2`,
      [tenantId, pattern.vendor_name]
    );

    const reliability = vendorScore.rows.length > 0
      ? parseFloat(vendorScore.rows[0].reliability_score)
      : 0;

    // Only suggest if vendor also has good reliability
    if (reliability < 60) continue;

    const amountRange = bucketToAmountRange(pattern.amount_bucket);

    suggestions.push({
      type: "auto_approve",
      reason: `${pattern.approver_email} has approved ${pattern.occurrence_count} invoices from ${pattern.vendor_name} in the ${pattern.amount_bucket} range with ${(pattern.confidence * 100).toFixed(0)}% consistency. Vendor reliability: ${reliability}/100.`,
      suggested_rule: {
        rule_name: `Auto-approve ${pattern.vendor_name} (${pattern.amount_bucket})`,
        rule_type: "auto_approve",
        conditions: {
          vendor: pattern.vendor_name,
          ...amountRange,
          is_known_vendor: true,
          vendor_score_min: 60
        },
        action: "approve",
        priority: 50
      },
      evidence: {
        approver: pattern.approver_email,
        occurrences: pattern.occurrence_count,
        pattern_confidence: parseFloat(pattern.confidence),
        vendor_reliability: reliability
      }
    });
  }

  return suggestions;
}

// ===============================
// MAIN API: ANALYZE INVOICE
// ===============================
app.post("/analyze-invoice", async (req, res) => {

  const invoice = req.body;

  try {

    // -------------------------------
    // INPUT VALIDATION
    // -------------------------------
    if (!invoice.vendor || !invoice.amount || !invoice.date) {
      return res.status(400).json({ error: "Missing required fields: vendor, amount, date" });
    }

    const amount = parseFloat(invoice.amount);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: "amount must be a positive number" });
    }

    // -------------------------------
    // TENANT CHECK
    // -------------------------------
    const tenantId = invoice.tenant_id;

    const tenant = await validateTenant(tenantId);
    if (!tenant) {
      return res.status(400).json({ error: "Missing or invalid tenant_id" });
    }

    console.log("Incoming Invoice:", invoice.invoice_id, invoice.vendor, amount);

    // -------------------------------
    // VENDOR INTELLIGENCE: Load or create vendor score
    // -------------------------------
    const vendorScore = await getOrCreateVendorScore(tenantId, invoice.vendor);

    // -------------------------------
    // Vendor History (tenant-scoped) — for LLM context + hard rules
    // -------------------------------
    const vendorHistory = await pool.query(
      `SELECT AVG(amount) as avg_amount
       FROM invoices WHERE vendor=$1 AND tenant_id=$2`,
      [invoice.vendor, tenantId]
    );

    const avgAmount = parseFloat(vendorHistory.rows[0].avg_amount) || 0;

    // -------------------------------
    // Duplicate Check (tenant-scoped)
    // -------------------------------
    const duplicateCheck = await pool.query(
      `SELECT 1 FROM invoices
       WHERE vendor=$1 AND amount=$2 AND tenant_id=$3
       AND invoice_date > NOW() - interval '30 days'
       LIMIT 1`,
      [invoice.vendor, amount, tenantId]
    );

    const possibleDuplicate = duplicateCheck.rows.length > 0;

    // ===============================
    // RULES ENGINE: Evaluate BEFORE LLM
    // ===============================
    let result;
    let decisionSource = "llm"; // default
    let matchedRuleId = null;

    const ruleResult = await evaluateRules(tenantId, invoice, vendorScore, possibleDuplicate);

    if (ruleResult) {
      // Rule matched — skip LLM entirely
      result = {
        confidence: ruleResult.action === "approve" ? 0.95 : ruleResult.action === "reject" ? 0.99 : 0.7,
        action: ruleResult.action,
        reasoning: ruleResult.reasoning
      };
      decisionSource = "rules_engine";
      matchedRuleId = ruleResult.ruleId;

      console.log(`Rules engine decided: ${result.action} (skipped LLM)`);
    } else {
      // No rule matched — call OpenAI
      console.log("No rule matched — calling LLM");

      // Build LLM payload (no tenant_id sent to third party)
      const llmPayload = {
        invoice_id: invoice.invoice_id,
        vendor: invoice.vendor,
        amount: amount,
        department: invoice.department,
        date: invoice.date
      };

      // Enrich AI prompt with intelligence context
      const vendorContext = vendorScore.total_invoices > 0
        ? `Vendor "${invoice.vendor}" profile: reliability ${vendorScore.reliability_score}/100, ${vendorScore.total_invoices} past invoices, avg amount ${vendorScore.avg_amount || "unknown"}, dispute rate ${(vendorScore.dispute_rate * 100).toFixed(1)}%.`
        : `Vendor "${invoice.vendor}" is new — no prior history.`;

      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `
You are a financial controller for ${tenant.name}.

Return ONLY valid JSON.

Format:
{
  "confidence": number (0-1),
  "action": "approve" | "review" | "reject",
  "reasoning": "string"
}

Context:
${vendorContext}
Vendor avg invoice: ${avgAmount || "no history"}
Possible duplicate: ${possibleDuplicate}
`
          },
          {
            role: "user",
            content: JSON.stringify(llmPayload)
          }
        ],
        temperature: 0
      });

      // Safe parsing
      let resultText = response.choices[0].message.content.trim();
      resultText = resultText.replace(/```json/g, "").replace(/```/g, "").trim();

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
    }

    // -------------------------------
    // CONFIDENCE NORMALIZATION
    // -------------------------------
    const confidenceScore = typeof result.confidence === "number" ? result.confidence : 0.6;

    const confidenceLevel =
      confidenceScore >= 0.8 ? "high" :
      confidenceScore >= 0.5 ? "medium" : "low";

    // -------------------------------
    // HARD RULES — override both rules engine and LLM
    // These are safety-critical and always run
    // -------------------------------
    let hardRuleFired = false;

    if (avgAmount > 0 && amount > 3 * avgAmount) {
      result.action = "review";
      result.reasoning = "Amount exceeds 3x vendor average";
      hardRuleFired = true;
    }

    // Duplicate check runs LAST so it always wins
    if (possibleDuplicate) {
      result.action = "reject";
      result.reasoning = "Duplicate invoice detected";
      hardRuleFired = true;
    }

    if (hardRuleFired) {
      decisionSource = "hard_rule";
    }

    console.log("Final Decision:", result.action, `(source: ${decisionSource})`);

    // -------------------------------
    // TOKEN GENERATION
    // -------------------------------
    const token = crypto.randomBytes(32).toString("hex");

    // -------------------------------
    // APPROVER EMAIL
    // -------------------------------
    const approver = invoice.approver_email || process.env.EMAIL_USER;

    // -------------------------------
    // SAVE INVOICE (tenant-scoped)
    // -------------------------------
    const insertResult = await pool.query(
      `INSERT INTO invoices
      (invoice_id, vendor, amount, department, invoice_date,
       decision, confidence, confidence_score, reasoning,
       approval_status, approval_token, token_expiry, approved_by,
       tenant_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW() + interval '1 hour', $12, $13)
      RETURNING id`,
      [
        invoice.invoice_id,
        invoice.vendor,
        amount,
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

    const invoiceDbId = insertResult.rows[0].id;

    // -------------------------------
    // INTELLIGENCE: Record prediction
    // -------------------------------
    await recordPrediction(
      tenantId,
      invoice.invoice_id,
      invoiceDbId,
      result.action,
      confidenceScore,
      decisionSource,
      matchedRuleId
    );

    // -------------------------------
    // INTELLIGENCE: Update vendor score (invoice count + avg)
    // -------------------------------
    await updateVendorScoreOnInvoice(tenantId, invoice.vendor, amount);

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
          amount: amount,
          decision: result.action,
          confidence: confidenceLevel,
          decision_source: decisionSource,
          rule_name: decisionSource === "rules_engine" ? result.reasoning : null
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
      confidence: confidenceLevel,
      decision_source: decisionSource
    });

    // -------------------------------
    // EMAIL (fire-and-forget via Resend)
    // -------------------------------
    const baseUrl = process.env.APP_URL || "http://localhost:3000";
    const approveUrl = `${baseUrl}/approve?token=${token}`;
    const rejectUrl = `${baseUrl}/reject?token=${token}`;

    resend.emails.send({
      from: "Embed ACA <noreply@mail.embedlab.co>",
      to: [approver],
      subject: `Invoice Approval — ${tenant.name}`,
      html: `
        <h2>Invoice Approval Needed</h2>
        <p><b>Company:</b> ${tenant.name}</p>
        <p><b>Vendor:</b> ${invoice.vendor}</p>
        <p><b>Amount:</b> ${amount}</p>
        <p><b>AI Decision:</b> ${result.action}</p>
        <p><b>Source:</b> ${decisionSource === "rules_engine" ? "Auto-rule" : decisionSource === "hard_rule" ? "Safety rule" : "AI analysis"}</p>

        <a href="${approveUrl}">Approve</a><br/><br/>
        <a href="${rejectUrl}">Reject</a>

        <p>This link expires in 1 hour</p>
      `
    }).then((emailResult) => {
      console.log("Email sent via Resend:", emailResult);
    }).catch((emailErr) => {
      console.error("Resend email failed:", emailErr);
    });

  } catch (error) {
    console.error("ACA Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===============================
// APPROVE (SECURE)
// ===============================
app.get("/approve", async (req, res) => {

  const { token } = req.query;

  if (!token) {
    return res.send("Missing token ❌");
  }

  try {

    const result = await pool.query(
      `SELECT * FROM invoices
       WHERE approval_token=$1
       AND token_expiry > NOW()
       AND approval_status='pending'`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.send("Invalid, expired, or already processed token ❌");
    }

    const invoice = result.rows[0];

    // Update status AND invalidate token to prevent replay
    await pool.query(
      `UPDATE invoices
       SET approval_status='approved',
           approved_at=NOW(),
           approval_token=NULL
       WHERE approval_token=$1`,
      [token]
    );

    // INTELLIGENCE: Close prediction with actual outcome
    await closePrediction(invoice.tenant_id, invoice.invoice_id, "approved");

    // INTELLIGENCE: Update vendor score based on approval
    await updateVendorScoreOnApproval(invoice.tenant_id, invoice.vendor, "approved");

    // INTELLIGENCE: Record approval pattern
    await updateApprovalPattern(
      invoice.tenant_id,
      invoice.approved_by,
      invoice.vendor,
      parseFloat(invoice.amount),
      "approved"
    );

    // AUDIT LOG
    await pool.query(
      `INSERT INTO audit_log (event, metadata, tenant_id)
       VALUES ($1, $2, $3)`,
      [
        "invoice_approved",
        JSON.stringify({
          invoice_id: invoice.invoice_id,
          approved_by: invoice.approved_by,
          vendor: invoice.vendor,
          amount: parseFloat(invoice.amount)
        }),
        invoice.tenant_id
      ]
    );

    res.send("✅ Approved securely");

  } catch (error) {
    console.error("Approve Error:", error);
    res.status(500).send("Something went wrong. Please try again.");
  }
});

// ===============================
// REJECT (SECURE)
// ===============================
app.get("/reject", async (req, res) => {

  const { token } = req.query;

  if (!token) {
    return res.send("Missing token ❌");
  }

  try {

    const result = await pool.query(
      `SELECT * FROM invoices
       WHERE approval_token=$1
       AND token_expiry > NOW()
       AND approval_status='pending'`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.send("Invalid, expired, or already processed token ❌");
    }

    const invoice = result.rows[0];

    // Update status AND invalidate token to prevent replay
    await pool.query(
      `UPDATE invoices
       SET approval_status='rejected',
           approved_at=NOW(),
           approval_token=NULL
       WHERE approval_token=$1`,
      [token]
    );

    // INTELLIGENCE: Close prediction with actual outcome
    await closePrediction(invoice.tenant_id, invoice.invoice_id, "rejected");

    // INTELLIGENCE: Update vendor score based on rejection
    await updateVendorScoreOnApproval(invoice.tenant_id, invoice.vendor, "rejected");

    // INTELLIGENCE: Record rejection pattern
    await updateApprovalPattern(
      invoice.tenant_id,
      invoice.approved_by,
      invoice.vendor,
      parseFloat(invoice.amount),
      "rejected"
    );

    // AUDIT LOG
    await pool.query(
      `INSERT INTO audit_log (event, metadata, tenant_id)
       VALUES ($1, $2, $3)`,
      [
        "invoice_rejected",
        JSON.stringify({
          invoice_id: invoice.invoice_id,
          rejected_by: invoice.approved_by,
          vendor: invoice.vendor,
          amount: parseFloat(invoice.amount)
        }),
        invoice.tenant_id
      ]
    );

    res.send("❌ Rejected securely");

  } catch (error) {
    console.error("Reject Error:", error);
    res.status(500).send("Something went wrong. Please try again.");
  }
});

// ===============================
// INTELLIGENCE DASHBOARD ENDPOINT
// ===============================
app.get("/intelligence", async (req, res) => {

  const tenantId = req.query.tenant_id;

  try {
    const tenant = await validateTenant(tenantId);
    if (!tenant) {
      return res.status(400).json({ error: "Missing or invalid tenant_id" });
    }

    // --- SYSTEM STATS ---
    const statsResult = await pool.query(
      `SELECT
         COUNT(*) as total_invoices,
         COUNT(*) FILTER (WHERE approval_status = 'approved') as total_approved,
         COUNT(*) FILTER (WHERE approval_status = 'rejected') as total_rejected,
         COUNT(*) FILTER (WHERE approval_status = 'pending') as total_pending,
         COALESCE(SUM(amount), 0) as total_amount,
         COALESCE(SUM(amount) FILTER (WHERE approval_status = 'pending'), 0) as pending_amount
       FROM invoices WHERE tenant_id = $1`,
      [tenantId]
    );

    const stats = statsResult.rows[0];

    // --- DECISION SOURCE BREAKDOWN ---
    const sourceBreakdown = await pool.query(
      `SELECT
         decision_source,
         COUNT(*) as count
       FROM prediction_confidence
       WHERE tenant_id = $1
       GROUP BY decision_source`,
      [tenantId]
    );

    const decisionSources = {};
    let totalDecisions = 0;
    for (const row of sourceBreakdown.rows) {
      decisionSources[row.decision_source] = parseInt(row.count);
      totalDecisions += parseInt(row.count);
    }

    const autoDecisionRate = totalDecisions > 0
      ? ((decisionSources.rules_engine || 0) + (decisionSources.hard_rule || 0)) / totalDecisions
      : 0;

    // --- PREDICTION ACCURACY ---
    const accuracyResult = await pool.query(
      `SELECT
         COUNT(*) as total_closed,
         COUNT(*) FILTER (WHERE was_correct = TRUE) as correct,
         COUNT(*) FILTER (WHERE was_correct = FALSE) as incorrect
       FROM prediction_confidence
       WHERE tenant_id = $1 AND actual_outcome IS NOT NULL`,
      [tenantId]
    );

    const accuracy = accuracyResult.rows[0];
    const predictionAccuracy = parseInt(accuracy.total_closed) > 0
      ? parseInt(accuracy.correct) / parseInt(accuracy.total_closed)
      : null;

    // --- VENDOR SCORES (top 20 by invoice count) ---
    const vendorScores = await pool.query(
      `SELECT vendor_name, reliability_score, total_invoices, total_approved,
              total_rejected, total_paid, avg_amount, dispute_rate, last_updated
       FROM vendor_scores
       WHERE tenant_id = $1
       ORDER BY total_invoices DESC
       LIMIT 20`,
      [tenantId]
    );

    // --- APPROVAL PATTERNS (top 20 by occurrence) ---
    const approvalPatterns = await pool.query(
      `SELECT approver_email, vendor_name, amount_bucket, decision,
              occurrence_count, confidence, last_observed
       FROM approval_patterns
       WHERE tenant_id = $1
       ORDER BY occurrence_count DESC
       LIMIT 20`,
      [tenantId]
    );

    // --- RULE SUGGESTIONS ---
    const suggestions = await generateRuleSuggestions(tenantId);

    // --- ACTIVE RULES ---
    const activeRules = await pool.query(
      `SELECT id, rule_name, rule_type, conditions, action, priority
       FROM tenant_rules
       WHERE tenant_id = $1 AND is_active = TRUE
       ORDER BY priority ASC`,
      [tenantId]
    );

    // --- RECENT PREDICTIONS (last 10) ---
    const recentPredictions = await pool.query(
      `SELECT invoice_id, predicted_action, confidence_score, decision_source,
              actual_outcome, was_correct, created_at
       FROM prediction_confidence
       WHERE tenant_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [tenantId]
    );

    res.json({
      tenant: tenant.name,
      system_stats: {
        total_invoices: parseInt(stats.total_invoices),
        total_approved: parseInt(stats.total_approved),
        total_rejected: parseInt(stats.total_rejected),
        total_pending: parseInt(stats.total_pending),
        total_amount: parseFloat(stats.total_amount),
        pending_amount: parseFloat(stats.pending_amount)
      },
      decision_engine: {
        total_decisions: totalDecisions,
        by_source: decisionSources,
        auto_decision_rate: parseFloat(autoDecisionRate.toFixed(4)),
        llm_calls_saved: (decisionSources.rules_engine || 0) + (decisionSources.hard_rule || 0)
      },
      prediction_accuracy: {
        total_closed: parseInt(accuracy.total_closed),
        correct: parseInt(accuracy.correct),
        incorrect: parseInt(accuracy.incorrect),
        accuracy: predictionAccuracy !== null ? parseFloat(predictionAccuracy.toFixed(4)) : null
      },
      vendor_intelligence: vendorScores.rows.map(v => ({
        vendor_name: v.vendor_name,
        reliability_score: parseFloat(v.reliability_score),
        total_invoices: v.total_invoices,
        total_approved: v.total_approved,
        total_rejected: v.total_rejected,
        avg_amount: v.avg_amount ? parseFloat(v.avg_amount) : null,
        dispute_rate: parseFloat(v.dispute_rate),
        last_updated: v.last_updated
      })),
      approval_patterns: approvalPatterns.rows.map(p => ({
        approver: p.approver_email,
        vendor: p.vendor_name,
        amount_bucket: p.amount_bucket,
        decision: p.decision,
        occurrences: p.occurrence_count,
        confidence: parseFloat(p.confidence),
        last_observed: p.last_observed
      })),
      suggested_rules: suggestions,
      active_rules: activeRules.rows.map(r => ({
        id: r.id,
        name: r.rule_name,
        type: r.rule_type,
        conditions: r.conditions,
        action: r.action,
        priority: r.priority
      })),
      recent_predictions: recentPredictions.rows.map(p => ({
        invoice_id: p.invoice_id,
        predicted: p.predicted_action,
        confidence: parseFloat(p.confidence_score),
        source: p.decision_source,
        actual_outcome: p.actual_outcome,
        was_correct: p.was_correct,
        timestamp: p.created_at
      }))
    });

  } catch (error) {
    console.error("Intelligence Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===============================
// RULES LIST ENDPOINT
// ===============================
app.get("/rules", async (req, res) => {

  const tenantId = req.query.tenant_id;

  try {
    const tenant = await validateTenant(tenantId);
    if (!tenant) {
      return res.status(400).json({ error: "Missing or invalid tenant_id" });
    }

    const rules = await pool.query(
      `SELECT id, rule_name, rule_type, conditions, action, priority, is_active, created_at, updated_at
       FROM tenant_rules
       WHERE tenant_id = $1
       ORDER BY priority ASC`,
      [tenantId]
    );

    res.json({
      tenant: tenant.name,
      total_rules: rules.rows.length,
      rules: rules.rows.map(r => ({
        id: r.id,
        name: r.rule_name,
        type: r.rule_type,
        conditions: r.conditions,
        action: r.action,
        priority: r.priority,
        is_active: r.is_active,
        created_at: r.created_at,
        updated_at: r.updated_at
      }))
    });

  } catch (error) {
    console.error("Rules Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// -------------------------------
app.get("/", (req, res) => {
  res.send("Secure ACA Agent Running — Intelligence Layer Active");
});

// -------------------------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Secure ACA running on port ${PORT} — Rules engine + Intelligence layer active`);
});
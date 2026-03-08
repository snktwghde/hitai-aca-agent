import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Invoice analysis endpoint
app.post("/analyze-invoice", async (req, res) => {

  const invoice = req.body;

  try {

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are a senior financial controller with 20+ years of experience at top finance firms analyzing invoices."
        },
        {
          role: "user",
          content: `Analyze this invoice and return ONLY JSON with fields: confidence, action, reasoning.

Invoice data:
${JSON.stringify(invoice)}`
        }
      ],
      temperature: 0
    });

    const resultText = response.choices[0].message.content.trim();

    // Try parsing JSON safely
    let result;

    try {
      result = JSON.parse(resultText);
    } catch (e) {
      console.log("JSON parse failed, returning raw text");
      result = {
        confidence: "unknown",
        action: "review",
        reasoning: resultText
      };
    }

    res.json(result);

  } catch (error) {

    console.error(error);
    res.status(500).send("Error analyzing invoice");

  }

});

// Railway dynamic port
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`ACA Agent running on port ${PORT}`);
});

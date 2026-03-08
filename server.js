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
          content: "You are a senior financial controller analyzing invoices."
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

    // Remove markdown code blocks if present
    const cleaned = resultText
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    let result;

    try {
      result = JSON.parse(cleaned);
    } catch (e) {
      console.log("JSON parse failed, returning raw text");

      result = {
        confidence: "unknown",
        action: "review",
        reasoning: cleaned
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

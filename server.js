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
          content: `Analyze this invoice and return JSON with confidence, action, reasoning and category. Invoice data: ${JSON.stringify(invoice)}`
        }
      ]
    });

    res.send(response.choices[0].message.content);

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

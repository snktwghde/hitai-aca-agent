import express from "express";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.post("/analyze-invoice", async (req, res) => {

  const invoice = req.body;

  try {

    const response = await client.chat.completions.create({
      model: "gpt-4.1",
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`ACA Agent running on port ${PORT}`);
});

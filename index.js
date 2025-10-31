require('dotenv').config();
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

const SHEET_ID = process.env.SHEET_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID = 'asst_N6FFm0AI1aNBtBAcSZKr1lLH';

// Initialize OpenAI client
const openai = new OpenAI({
    apiKey: OPENAI_API_KEY
});

// Helper function to get data from Rank tab
async function getRankData() {
    // For public sheets we can use the CSV export endpoint which doesn't require auth.
    // If your sheet is private, we'll need to add service account credentials instead.
    const sheetName = 'Rank';
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
    const resp = await axios.get(url);
    const csv = resp.data;
    // Simple CSV parse (assumes header row with Rank and Company columns)
    const lines = csv.split(/\r?\n/).filter(l => l.trim());
    if (lines.length === 0) return [];
    const headers = lines.shift().split(',').map(h => h.replace(/^"|"$/g, '').trim());
    const rankIdx = headers.findIndex(h => /rank/i.test(h));
    const companyIdx = headers.findIndex(h => /company/i.test(h));
    const rows = lines.map(line => {
        // naive split — should be fine for simple values without commas inside
        const cols = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
        return { Rank: cols[rankIdx] || '', Company: cols[companyIdx] || '' };
    });
    return rows;
}

// Use the Skill Lab Internal Bot assistant to process queries
async function getGPTResponse(query, rankData) {
    try {
        // Create a thread
        const thread = await openai.beta.threads.create();
        
        // Add a message to the thread with the rank data and query
        await openai.beta.threads.messages.create(thread.id, {
            role: "user",
            content: `Here is the current rank data:\n${JSON.stringify(rankData, null, 2)}\n\nQuery: ${query}`
        });

        // Run the assistant
        const run = await openai.beta.threads.runs.create(thread.id, {
            assistant_id: ASSISTANT_ID
        });

        // Poll for the run to complete
        let runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
        while (runStatus.status === 'queued' || runStatus.status === 'in_progress') {
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
            runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
        }

        if (runStatus.status === 'completed') {
            // Get the assistant's response
            const messages = await openai.beta.threads.messages.list(thread.id);
            const lastMessage = messages.data[0]; // Get the most recent message
            return lastMessage.content[0].text.value;
        } else {
            throw new Error(`Run ended with status: ${runStatus.status}`);
        }
    } catch (error) {
        console.error('Error using Assistant:', error);
        throw error;
    }
}

// API endpoint for chatbot queries
app.post('/query', async (req, res) => {
    try {
        const { query } = req.body;
        if (!query) return res.status(400).json({ error: "Query is required" });

        const rankData = await getRankData();
        if (!rankData || rankData.length === 0) {
            return res.status(500).json({ error: "Could not fetch rank data from Google Sheets" });
        }

        const answer = await getGPTResponse(query, rankData);
        res.json({ answer });
    } catch (err) {
        console.error('Error processing query:', err);
        const errorMessage = err.response?.data?.error?.message || err.message || "Server error";
        res.status(500).json({ error: errorMessage });
    }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

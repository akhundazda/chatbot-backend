require('dotenv').config();
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');

const app = express();

// CORS middleware - allows Typebot to call your API
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json());

const SHEET_ID = process.env.SHEET_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID = 'asst_N6FFm0AI1aNBtBAcSZKr1lLH';

// Initialize OpenAI client
const openai = new OpenAI({
    apiKey: OPENAI_API_KEY
});

// Root route for health check
app.get('/', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'Chatbot Backend API is running',
        endpoints: {
            health: 'GET / - Check API status',
            query: 'POST /query - Send a query with rank data (body: { "query": "your question" })'
        },
        version: '1.0.0'
    });
});

// Health check endpoint (useful for monitoring)
app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Helper function to get data from Rank tab
async function getRankData() {
    try {
        const sheetName = 'Rank';
        const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
        const resp = await axios.get(url, { timeout: 10000 });
        const csv = resp.data;
        
        const lines = csv.split(/\r?\n/).filter(l => l.trim());
        if (lines.length === 0) return [];
        
        const headers = lines.shift().split(',').map(h => h.replace(/^"|"$/g, '').trim());
        const rankIdx = headers.findIndex(h => /rank/i.test(h));
        const companyIdx = headers.findIndex(h => /company/i.test(h));
        
        const rows = lines.map(line => {
            const cols = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
            return { Rank: cols[rankIdx] || '', Company: cols[companyIdx] || '' };
        });
        
        return rows;
    } catch (error) {
        console.error('Error fetching Google Sheets data:', error.message);
        throw new Error('Failed to fetch rank data from Google Sheets');
    }
}

// Use the OpenAI Assistant to process queries
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

        // Poll for the run to complete (with timeout)
        let runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
        let attempts = 0;
        const maxAttempts = 60; // 60 seconds timeout
        
        while ((runStatus.status === 'queued' || runStatus.status === 'in_progress') && attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
            attempts++;
        }

        if (runStatus.status === 'completed') {
            const messages = await openai.beta.threads.messages.list(thread.id);
            const lastMessage = messages.data[0];
            return lastMessage.content[0].text.value;
        } else {
            throw new Error(`Assistant run ended with status: ${runStatus.status}`);
        }
    } catch (error) {
        console.error('Error using OpenAI Assistant:', error.message);
        throw new Error('Failed to get response from AI assistant');
    }
}

// Main API endpoint for Typebot
app.post('/query', async (req, res) => {
    try {
        const { query } = req.body;
        
        // Validate input
        if (!query || typeof query !== 'string' || query.trim() === '') {
            return res.status(400).json({ 
                error: "Invalid request",
                message: "Query is required and must be a non-empty string",
                example: { query: "What is the top ranked company?" }
            });
        }

        console.log('Received query:', query);

        // Fetch rank data from Google Sheets
        const rankData = await getRankData();
        
        if (!rankData || rankData.length === 0) {
            return res.status(500).json({ 
                error: "Data unavailable",
                message: "Could not fetch rank data from Google Sheets. Please try again later."
            });
        }

        console.log(`Fetched ${rankData.length} rows from Google Sheets`);

        // Get AI response
        const answer = await getGPTResponse(query, rankData);
        
        console.log('Generated answer successfully');

        // Return response in a format Typebot can easily use
        res.json({ 
            success: true,
            answer: answer,
            timestamp: new Date().toISOString()
        });

    } catch (err) {
        console.error('Error processing query:', err);
        
        // Return user-friendly error message
        const errorMessage = err.message || "An unexpected error occurred";
        res.status(500).json({ 
            success: false,
            error: "Processing failed",
            message: errorMessage,
            timestamp: new Date().toISOString()
        });
    }
});

// Catch-all for undefined routes
app.use((req, res) => {
    res.status(404).json({
        error: "Not Found",
        message: `Route ${req.method} ${req.path} does not exist`,
        availableEndpoints: {
            health: 'GET /',
            query: 'POST /query'
        }
    });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📍 API URL: http://localhost:${PORT}`);
    console.log(`🔗 Endpoints:`);
    console.log(`   - GET  / (health check)`);
    console.log(`   - POST /query (main endpoint)`);
});
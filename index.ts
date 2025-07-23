import { GoogleGenerativeAI } from "@google/generative-ai";
import { Pinecone } from "@pinecone-database/pinecone";
import axios from 'axios';
import * as cheerio from 'cheerio';
import 'dotenv/config';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX_NAME = process.env.PINECONE_INDEX_NAME;

if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set in the environment variables.');
}

if (!PINECONE_API_KEY) {
    throw new Error('PINECONE_API_KEY is not set in the environment variables.');
}

if (!PINECONE_INDEX_NAME) {
    throw new Error('PINECONE_INDEX_NAME is not set in the environment variables.');
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const pc = new Pinecone({
    apiKey: PINECONE_API_KEY,
 });

// Function for scrape content from URL
async function scrapeContent(url: string): Promise<string> {
    try {
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);

        // Remove scripts, styles, and other unwanted elements
        $('script, style, nav, header, footer, aside').remove();

        // Get the main content
        let content = $('main').text() ||
            $('article').text() ||
            $('body').text() ||
            $('.content').text() ||
            $('#content').text();

        // Clean up the content
        content = content.replace(/\s+/g, ' ').trim();
        return content.substring(0, 5000); // Limit to 5000 characters

    } catch (error) {
        console.error('Error scraping content:', error);
        return '';
    }
}

// Function to chunk content into smaller pieces
function chunkContent(content: string, chunkSize: number = 1000): string[] {
    const chunks = [];
    for (let i = 0; i < content.length; i += chunkSize) {
        chunks.push(content.substring(i, i + chunkSize));
    }
    return chunks;
}

// Function to store content in Pinecone
async function storeUrlInPinecone(url: string): Promise<void> {
    console.log(`Storing content from URL: ${url}`);

    // Scrape content from the URL
    const content = await scrapeContent(url);
    if (!content) {
        console.error('No content scraped from the URL.');
        return;
    }

    // Split content into chunks
    const chunks = chunkContent(content, 800);
    console.log(`Content split into ${chunks.length} chunks.`);

    // Create embeddings for each chunk
    const embeddingModel = genAI.getGenerativeModel({ model: 'embedding-001' });
    const index = pc.index(PINECONE_INDEX_NAME as string);

    for (let i = 0; i < chunks.length; i++) {
        try {
            const embedding = await embeddingModel.embedContent(chunks[i]);

            await index.upsert([{
                id: `${url}-chunk-${i}`,
                values: embedding.embedding.values,
                metadata: {
                    url: url,
                    source: url,
                    content: chunks[i]
                }
            }]);

        } catch (error) {
            console.error('Error storing chunk in Pinecone:', error);
        }
    }
}


async function main() {
    const userQuery = 'What are the latest Innovations?';

    const urlsToScrape = [
        'https://www.bbc.com/innovation',
        'https://www.bbc.com/innovation/technology'
    ];

    // Store the URL content in Pinecone
    console.log('Storing URLs in Pinecone...');
    for (const url of urlsToScrape) {
        await storeUrlInPinecone(url);
    }

    console.log('All URLs stored in Pinecone.');


    // Create an embedding for the user query

    const embeddingModel = genAI.getGenerativeModel({ model: "embedding-001" });
    const embedding = await embeddingModel.embedContent(userQuery);

    // Search Pinecone for similar content
    const index = pc.index(PINECONE_INDEX_NAME as string);
    const queryResponse = await index.query({
        vector: embedding.embedding.values,
        topK: 5,
        includeMetadata: true,
    });

    // Get content from the search results
    const context = queryResponse.matches
        .map(match => `Source: ${match.metadata?.source}\nContent: ${match.metadata?.content}`)
        .join('\n\n---\n\n');

    // Generate a response with Gemini AI
    const chatModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = `Context from web sources:\n${context}\n\nQuestion: ${userQuery}\n\nAnswer based on the context:`;

    const result = await chatModel.generateContent(prompt);
    const response = result.response;
    const text = response.text();
    console.log('Response from Gemini AI:', text);
    console.log('Context used for the response:', context);
}

main().catch(console.error);
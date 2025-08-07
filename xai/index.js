// xai/index.js
import { z } from 'zod';
import axios from 'axios';
import { CosmosClient } from '@azure/cosmos';

const schema = z.array(
  z.object({
    company_name: z.string(),
    company_tagline: z.string().optional(),
    industries: z.array(z.string()),
    product_keywords: z.string(),
    url: z.string().optional(),
    email_address: z.string().optional(),
    headquarters_location: z.string(),
    manufacturing_locations: z.array(z.string()),
    amazon_url: z.string().optional(),
    red_flag: z.boolean().optional(),
    reviews: z.array(z.object({
      text: z.string(),
      link: z.string().optional(),
    })).optional(),
    lat: z.number().optional(), // HQ latitude
    long: z.number().optional(), // HQ longitude
    manu_lats: z.array(z.number()).optional(), // Manufacturing latitudes
    manu_lngs: z.array(z.number()).optional(), // Manufacturing longitudes
  })
);

function buildPrompt(query, previousCompanies = []) {
  let basePrompt = `Provide exactly 1 unique company that makes products related to (${query}), with no fewer, in this exact structured JSON format: [ {"company_name": "name", "company_tagline": "tagline", "industries": ["industry1"], "product_keywords": "keywords separated by comma", "url": "website", "email_address": "email", "headquarters_location": "location", "manufacturing_locations": ["location1"], "amazon_url": "amazon url", "red_flag": false, "reviews": [{"text": "review text", "link": "review link"}, ... (3 reviews)] } ]. Conduct a thorough search for this company to ensure complete and accurate data. Be maximally truthful and avoid hallucinations. Each field must match the key names exactly for successful import. Always include the Amazon store URL if the company has one (search for it if needed, format as "https://www.amazon.com/stores/BrandName/page/ID" or similar seller/store link). Include exactly 3 customer reviews with text and links from credible sources (prefer Consumer Reports, magazines, or verified retail like Amazon). Ensure companies are unique and different from previous results, with a focus on transparent supply chain and sustainable sourcing. If fewer than 1 are available, return what you have with a warning: []`;
  if (previousCompanies.length > 0) {
    basePrompt += ` Do not repeat any of these companies: ${previousCompanies.join(', ')}.`;
  }
  return basePrompt;
}

async function geocodeLocation(location) {
  const googleApiKey = process.env.GOOGLE_GEOCODING_API_KEY;
  if (!googleApiKey) {
    console.warn('Missing GOOGLE_GEOCODING_API_KEY - skipping geocoding');
    return { lat: 0, lng: 0 };
  }
  try {
    const response = await axios.get(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(location)}&key=${googleApiKey}`
    );
    const result = response.data.results[0];
    if (result && result.geometry && result.geometry.location) {
      return { lat: result.geometry.location.lat, lng: result.geometry.location.lng };
    } else {
      console.warn(`Geocoding failed for location: ${location}`);
      return { lat: 0, lng: 0 };
    }
  } catch (error) {
    console.error(`Geocoding error for ${location}:`, error.message);
    return { lat: 0, lng: 0 };
  }
}

async function callXAI(query) {
  const xaiApiKey = process.env.XAI_API_KEY;
  if (!xaiApiKey) throw new Error('Missing XAI_API_KEY');
  let allCompanies = [];
  let page = 1;
  const maxPages = 1; // Set to 1 for testing to avoid long runs
  while (page <= maxPages) {
    try {
      const prompt = buildPrompt(query, allCompanies.map(c => c.company_name));
      console.log(`Calling xAI API for company ${page} at ${new Date().toISOString()}`);
      const response = await axios.post('https://api.x.ai/v1/chat/completions', {
        model: 'grok-4-latest',
        messages: [{ role: 'user', content: prompt + ` Return result ${page}.` }],
        temperature: 0.2,
      }, {
        headers: { 'Authorization': `Bearer ${xaiApiKey}` },
        timeout: 0, // No timeout for local; change to 600000 for production
      });
      const content = response.data?.choices?.[0]?.message?.content;
      if (!content || !content.trim().startsWith('[')) {
        console.warn(`No valid JSON array on result ${page} at ${new Date().toISOString()} - stopping.`);
        break;
      }
      let pageCompanies;
      try {
        pageCompanies = JSON.parse(content);
        console.log(`Parsed company on result ${page} at ${new Date().toISOString()}:`, JSON.stringify(pageCompanies, null, 2));
      } catch (parseError) {
        console.error(`Failed to parse JSON on result ${page} at ${new Date().toISOString()}:`, parseError.message);
        break;
      }
      if (!Array.isArray(pageCompanies) || pageCompanies.length === 0) {
        console.warn(`No new company on result ${page} at ${new Date().toISOString()} - stopping.`);
        break;
      }
      const taggedCompanies = await Promise.all(pageCompanies.map(async (company) => {
        if (!company || typeof company !== 'object') {
          console.warn(`Invalid company object on result ${page} at ${new Date().toISOString()} - skipping.`);
          return null;
        }

        // Geocode headquarters
        const hqGeocode = await geocodeLocation(company.headquarters_location || company.headquarters || 'Unknown');

        // Geocode each manufacturing location
        const manuLats = [];
        const manuLngs = [];
        for (const loc of (company.manufacturing_locations || [company.manufacturing || 'Unknown'])) {
          const manuGeocode = await geocodeLocation(loc);
          manuLats.push(manuGeocode.lat);
          manuLngs.push(manuGeocode.lng);
        }

        return {
          company_name: company.company_name || company.name || company.company || 'Unknown',
          company_tagline: company.company_tagline || (company.description || company.product_focus || company.products || '').split('. ')[0] || '',
          industries: company.industries || [company.category || company.related_products || 'Unknown'],
          product_keywords: company.product_keywords || (company.description || company.product_focus || company.products || company.related_products || '').match(/\b\w+\b/g)?.slice(1, 4).join(', ') || 'Unknown',
          url: company.url || company.website || '',
          email_address: company.email_address || company.email || '',
          headquarters_location: company.headquarters_location || company.headquarters || 'Unknown',
          manufacturing_locations: company.manufacturing_locations || [company.manufacturing || 'Unknown'],
          amazon_url: company.amazon_url || company.amazon_store || company.amazonStoreUrl || company.amazon_store_url || '',
          red_flag: company.red_flag || false,
          reviews: company.reviews || [],
          lat: hqGeocode.lat,
          long: hqGeocode.lng,
          manu_lats: manuLats,
          manu_lngs: manuLngs,
        };
      })).then(results => results.filter(c => c !== null));

      const newCompanies = taggedCompanies.filter(c => !allCompanies.some(existing => existing.company_name === c.company_name));
      allCompanies = [...allCompanies, ...newCompanies];
      console.log(`Fetched ${newCompanies.length} new company on result ${page} at ${new Date().toISOString()}`);
      if (newCompanies.length < 1) break; // Stop if no new company
      page++;
    } catch (error) {
      console.error(`Fetch error on result ${page} at ${new Date().toISOString()}:`, error.message);
      page++; // Continue to next
    }
  }
  return allCompanies.length > 0 ? allCompanies : [];
}

export default async function run(request, context) {
  console.log('Full request object:', JSON.stringify(request, null, 2));
  const headers = request?.bindings?.request?.headers || {};
  const origin = headers.origin || '*';

  console.log('Request headers:', JSON.stringify(headers, null, 2));
  console.log('Request method:', request?.bindings?.request?.method);

  if (request?.bindings?.request?.method === 'OPTIONS') {
    console.log('Handling OPTIONS request');
    return {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    };
  }

  if (request?.bindings?.request?.method !== 'POST') {
    console.log('Method not POST, returning 405');
    return {
      status: 405,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  const body = request?.bindings?.request?.body || await request.json();
  console.log('Request body:', body);
  const { query } = body;
  if (!query || typeof query !== 'string') {
    console.log('Invalid query:', query);
    return {
      status: 400,
      body: JSON.stringify({ error: 'Missing or invalid query' }),
    };
  }

  try {
    console.log('Processing query:', query);
    const companies = await callXAI(query);
    console.log('Companies fetched:', companies.length);
    console.log('Companies data:', JSON.stringify(companies, null, 2));
    const validatedCompanies = schema.parse(companies); // Validate with zod

    // Save to Cosmos DB
    const client = new CosmosClient({
      endpoint: 'https://tabarnam-cosmos-db.documents.azure.com:443/',
      key: process.env.COSMOS_DB_KEY
    });
    const database = client.database('TabarnamDB');
    const container = database.container('Companies');
    for (const company of validatedCompanies) {
      await container.items.upsert(company); // Upsert by company_name (partition key)
    }

    console.log(`✅ IMPORT SUCCESS: ${validatedCompanies.length} unique companies via xAI`);
    let status = 'complete';
    if (companies.length < 50) status = 'exhaustive - review or revise query';
    console.log('Returning 200 with body:', JSON.stringify({ companies: validatedCompanies, status }));
    return {
      status: 200,
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60' },
      body: JSON.stringify({ companies: validatedCompanies, status }),
    };
  } catch (error) {
    console.error('Error in execution:', error.message);
    if (error.errors) {
      console.error('Validation errors:', JSON.stringify(error.errors, null, 2));
    }
    return {
      status: 500,
      body: JSON.stringify({ error: error.message || 'Unknown error' }),
    };
  }
}
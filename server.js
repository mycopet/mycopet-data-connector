// server.js - minimal safe backend to set Shopify customer metafields
import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';

const app = express();
app.use(bodyParser.json({ limit: '128kb' }));

// Required env vars:
// SHOPIFY_SHOP (example "myco.pet")
// SHOPIFY_ADMIN_TOKEN (Admin API token you reveal from the app)
// OPTIONAL: APP_ALLOWED_SHOP (same as SHOPIFY_SHOP) - used to simple-check requests

const SHOP = process.env.myco.pet;
const ADMIN_TOKEN = process.env.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;
const APP_ALLOWED_SHOP = process.env.myco.pet || SHOP;

if (!SHOP || !ADMIN_TOKEN) {
  console.error('Missing SHOP or ADMIN_TOKEN env vars. Exiting.');
  process.exit(1);
}

// Very small helper to call Admin GraphQL
async function shopifyGraphQL(query, variables = {}) {
  const url = `https://${SHOP}/admin/api/2024-07/graphql.json`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': ADMIN_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  return resp.json();
}

// Basic check: only accept requests proxied from your shop domain
function isFromShopifyProxy(req) {
  // App Proxy requests come through shopify; header X-Forwarded-Host often equals shop domain.
  // This is a light check for MVP. For production, implement HMAC verification with your API secret.
  const forwardedHost = (req.get('x-forwarded-host') || '').toLowerCase();
  const host = (req.get('host') || '').toLowerCase();
  return forwardedHost.includes(APP_ALLOWED_SHOP) || host.includes(APP_ALLOWED_SHOP);
}

app.post('/mycopet-customer-update', async (req, res) => {
  try {
    // Accept JSON { email: "...", metafields: [ { namespace, key, type, value }, ... ] }
    if (!isFromShopifyProxy(req)) {
      // Return 200 to avoid breaking checkout; log for debugging
      console.warn('Rejected request not from allowed shop host:', req.get('host'), req.get('x-forwarded-host'));
      return res.status(200).json({ ok: false, reason: 'not-from-shopify-proxy' });
    }

    const body = req.body || {};
    const email = String(body.email || '').trim();
    const metafields = Array.isArray(body.metafields) ? body.metafields : [];

    if (!email || metafields.length === 0) {
      return res.status(200).json({ ok: true, skipped: 'missing email or metafields' });
    }

    // 1) Find customer by email
    const findQuery = `
      query($query: String!) {
        customers(first: 1, query: $query) {
          edges {
            node { id }
          }
        }
      }
    `;
    const findRes = await shopifyGraphQL(findQuery, { query: `email:${email}` });
    const customerId = findRes?.data?.customers?.edges?.[0]?.node?.id;
    if (!customerId) {
      console.warn('No customer found for email', email);
      return res.status(200).json({ ok: true, skipped: 'customer-not-found' });
    }

    // 2) Coerce types for common keys (match your metafield definitions)
    const DATE_KEYS = new Set(['pet_date_of_birth']);
    const DECIMAL_KEYS = new Set(['pet_weight_kg', 'pet_age_years']);

    const inputs = metafields.map(mf => {
      const ns = mf.namespace || 'profile';
      const key = mf.key;
      let value = mf.value ?? '';
      if (DATE_KEYS.has(key)) {
        const iso = new Date(String(value)).toISOString().slice(0,10);
        return { namespace: ns, key, type: 'date', value: iso };
      }
      if (DECIMAL_KEYS.has(key)) {
        const num = Number(String(value).replace(',', '.'));
        return { namespace: ns, key, type: 'number_decimal', value: isFinite(num) ? String(num) : '0' };
      }
      return { namespace: ns, key, type: 'single_line_text_field', value: String(value) };
    });

    // 3) Set metafields with Admin GraphQL
    const setMutation = `
      mutation($ownerId: ID!, $metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(ownerId: $ownerId, metafields: $metafields) {
          metafields { namespace key value type }
          userErrors { field message }
        }
      }
    `;
    const setRes = await shopifyGraphQL(setMutation, { ownerId: customerId, metafields: inputs });

    return res.status(200).json({ ok: true, result: setRes });
  } catch (err) {
    console.error('Error in /mycopet-customer-update', err);
    // Always return 200 so checkout isn't blocked by backend errors
    return res.status(200).json({ ok: false, error: String(err) });
  }
});

// Health check
app.get('/', (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`MycoPet connector listening on ${port}`));

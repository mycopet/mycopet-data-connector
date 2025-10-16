// server.js
import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';

const app = express();
app.use(bodyParser.json({ limit: '128kb' }));

const SHOP = process.env.SHOPIFY_SHOP;            // e.g. "myco.pet"
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

// --- CORS: allow only your store origin ---
const ALLOWED_ORIGIN = `https://${SHOP}`;
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && origin === ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

if (!SHOP || !ADMIN_TOKEN) {
  console.error('Missing SHOP or SHOPIFY_ADMIN_TOKEN env vars.');
  process.exit(1);
}

const gql = async (query, variables={}) => {
  const resp = await fetch(`https://${SHOP}/admin/api/2024-07/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'X-Shopify-Access-Token': ADMIN_TOKEN },
    body: JSON.stringify({ query, variables })
  });
  return resp.json();
};

app.post('/mycopet-customer-update', async (req, res) => {
  try {
    const { email, metafields } = req.body || {};
    if (!email || !Array.isArray(metafields) || metafields.length===0) {
      return res.status(200).json({ ok:true, skipped:'missing email or metafields' });
    }

    // 1) find customer
    const findQuery = `query($q:String!){ customers(first:1, query:$q){ edges{ node{ id } } } }`;
    const f = await gql(findQuery, { q: `email:${email}` });
    const id = f?.data?.customers?.edges?.[0]?.node?.id;
    if (!id) return res.status(200).json({ ok:true, skipped:'customer-not-found' });

    // 2) coerce types
    const DATE_KEYS = new Set(['pet_date_of_birth']);
    const DECIMAL_KEYS = new Set(['pet_weight_kg','pet_age_years']);
    const inputs = metafields.map(m => {
      const ns = m.namespace || 'profile';
      const key = m.key;
      if (DATE_KEYS.has(key)) {
        const iso = new Date(String(m.value)).toISOString().slice(0,10);
        return { namespace: ns, key, type:'date', value: iso };
      }
      if (DECIMAL_KEYS.has(key)) {
        const num = Number(String(m.value).replace(',', '.'));
        return { namespace: ns, key, type:'number_decimal', value: isFinite(num)? String(num): '0' };
      }
      return { namespace: ns, key, type:'single_line_text_field', value: String(m.value ?? '') };
    });

    // 3) set metafields
    const setMutation = `
      mutation($ownerId:ID!,$metafields:[MetafieldsSetInput!]!){
        metafieldsSet(ownerId:$ownerId, metafields:$metafields){
          metafields{ namespace key type value }
          userErrors{ field message }
        }
      }`;
    const r = await gql(setMutation, { ownerId: id, metafields: inputs });
    return res.status(200).json({ ok:true, result:r });
  } catch (e) {
    console.error('update error', e);
    return res.status(200).json({ ok:false, error:String(e) }); // never block checkout
  }
});

app.get('/', (_,res)=>res.json({ok:true}));
app.listen(process.env.PORT||3000, ()=>console.log('Ready'));

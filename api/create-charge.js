const https = require('https');

function omiseRequest(path, data, secretKey) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(data).toString();
    const auth = Buffer.from(secretKey + ':').toString('base64');
    const options = {
      hostname: 'api.omise.co',
      path, method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { amount, contractRef, sessionId } = req.body;
    const key = process.env.OMISE_SECRET_KEY;

    const source = await omiseRequest('/sources', {
      type: 'promptpay',
      amount: Math.round(amount || 79000),
      currency: 'THB'
    }, key);

    const charge = await omiseRequest('/charges', {
      amount: Math.round(amount || 79000),
      currency: 'THB',
      source: source.id,
      description: `JustSign ${contractRef || ''}`,
      'metadata[session_id]': sessionId || '',
      'metadata[contract_ref]': contractRef || '',
      return_uri: 'https://oslomarco77.github.io/JustSign/?start=1&paid=1'
    }, key);

    return res.status(200).json({
      chargeId: charge.id,
      qrCode: source.scannable_code?.image?.download_uri || null,
      status: charge.status,
      amount: charge.amount,
      expiresAt: source.expires_at
    });

  } catch (err) {
    console.error('Opn error:', err);
    return res.status(500).json({ error: err.message });
  }
};
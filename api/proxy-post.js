export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const response = await fetch('https://script.google.com/macros/s/AKfycbyp2ntP4Jf0AGHXSQdxNW4kQRNjqElsEmnqsrxMdDWDk-KJ3cAN8LvJDgFfoECASWEz/exec', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({ error: 'Proxy failed', detail: error.message });
  }
}

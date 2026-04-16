export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(200).end();
  
    const { vector, namespace } = req.body;
  
    const response = await fetch(`${process.env.PINECONE_HOST}/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Api-Key": process.env.PINECONE_API_KEY,
      },
      body: JSON.stringify({ vector, namespace, topK: 3, includeMetadata: true }),
    });
    const data = await response.json();
    res.json(data);
  }
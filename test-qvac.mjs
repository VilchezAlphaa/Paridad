const response = await fetch("http://127.0.0.1:11434/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "qwen3-600m-inst-q4",
    messages: [
      {
        role: "user",
        content: "Responde solamente: QVAC FUNCIONA",
      },
    ],
    stream: false,
  }),
});

const data = await response.json();

console.log(data.choices?.[0]?.message?.content ?? data);
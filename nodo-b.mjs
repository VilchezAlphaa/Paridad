import Hyperswarm from "hyperswarm";
import crypto from "crypto";

const swarm = new Hyperswarm();
const topic = crypto
  .createHash("sha256")
  .update("paridad-test")
  .digest();

swarm.join(topic, { client: true, server: true });

swarm.on("connection", (conn) => {
  console.log("✅ Nodo B conectado");

  conn.on("data", (data) => {
    console.log("📩 Nodo B recibió:", data.toString());
    conn.write("Hola desde Nodo B");
  });
});
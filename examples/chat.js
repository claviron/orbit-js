// Two instances of one application share events through the fleet's ring:
//   node examples/chat.js <fleet> <name> <who>
// Each publishes `chat` once a second-instance appears and prints what it hears.
import process from "node:process";
import { join } from "../index.js";

const [fleet = "apps", name = "chat-js", who = String(process.pid)] = process.argv.slice(2);
const link = await join({ fleet, name });
console.log(`${who}: lane ${link.lane}`);

link.on("chat", (payload, event) => {
  console.log(`${who} heard ${JSON.stringify(payload)} (${event.id.slice(0, 8)})`);
});

// Reading stdin keeps the process alive (Deno does not let go of it on
// destroy), so the example exits once the lane is released.
const stop = async () => {
  await link.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.stdin.on("data", (line) => {
  link.publish("chat", { from: who, text: line.toString().trim() });
});
await link.serve(() => new Response("chat"));

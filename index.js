import express from "express";
import getRawBody from "raw-body";
import crypto from "crypto";
import { Octokit } from "@octokit/rest";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const { WEBHOOK_SECRET, GITHUB_TOKEN, PORT = 3000 } = process.env;

// This makes sure that the webhook signature is actually from github
function verify(sigHeader, raw) {
  const expected = "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  return sigHeader === expected;
}

app.post("/webhook", async (req, res) => {
  try {
    const raw = await getRawBody(req); // raw request body
    const sig = req.headers["x-hub-signature-256"];
    if (!sig || !verify(sig, raw)) return res.status(401).send("Bad signature");

    const event = req.headers["x-github-event"];
    const payload = JSON.parse(raw.toString("utf8"));

    // this makes sure it only actually activates when it's respondign to a PR
    if (event === "pull_request" && ["opened","synchronize","reopened"].includes(payload.action)) {
      const owner = payload.repository.owner.login;
      const repo  = payload.repository.name;
      const prNum = payload.number;

      // Verify that it's a github api call
      const octokit = new Octokit({ auth: GITHUB_TOKEN });

      // literally just checking a working call with "Hello"
      await octokit.issues.createComment({
        owner, repo, issue_number: prNum,
        body: "👋 **Neuron** here — webhook alive; diff captured. (Week-1 tracer bullet)"
      });

      console.log(`Posted hello to PR #${prNum} in ${owner}/${repo}`);
    }

    res.status(200).send("OK");
  } catch (e) {
    console.error(e);
    res.status(500).send("Error");
  }
});

// Simple GET endpoint for health checks
app.get("/", (_, res) => res.send("Neuron webhook running"));

app.listen(PORT, () => console.log(`Neuron webhook listening on :${PORT}`));

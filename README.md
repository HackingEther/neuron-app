# Neuron

A GitHub pull-request webhook service that uses an LLM to propose code-review comments and tests.

## Overview

Neuron receives pull-request events, gathers context from the changed files and repository, and asks an Azure OpenAI deployment for a structured review/test plan. It validates the plan with Ajv and uses a baseline to filter repeated comments. The workflow includes generating test changes and reporting results through GitHub.

The project explores how repository context, structured model output and duplicate filtering can make automated review more useful. It is experimental; generated findings and changes need human review.

## Architecture

- **Webhook service:** Node.js, ES modules and Express
- **GitHub integration:** Octokit
- **Model integration:** Azure OpenAI
- **Plan validation:** Ajv and JSON Schema
- **Repository analysis:** context/analyzer helpers, baseline tracking and test-result normalization

## Request flow

1. GitHub sends an event to `POST /webhook`.
2. The service verifies the webhook signature against the raw request body.
3. Supported pull-request actions (`opened`, `reopened`, `synchronize` and `ready_for_review`) trigger context collection.
4. Neuron requests a structured plan from the configured model deployment.
5. The plan is validated and repeated findings are filtered.
6. The review/test workflow generates proposed work and communicates results through GitHub.

The entry point is [index.js](./index.js). Supporting code includes [prompts.js](./prompts.js), [baseline.js](./baseline.js), [analyzers](./analyzers) and [run-and-normalize.js](./run-and-normalize.js).

## Local setup

Install Node.js and npm compatible with the dependencies in `package-lock.json`, then:

```sh
npm ci
cp .env.example .env
```

On Windows PowerShell, use `Copy-Item .env.example .env`.

Fill in the local environment file:

| Variable | Purpose |
| --- | --- |
| `WEBHOOK_SECRET` | Shared secret used to verify GitHub webhook signatures |
| `GITHUB_TOKEN` | GitHub credential for the repositories used by the service |
| `AZURE_OPENAI_ENDPOINT` | Endpoint for the Azure OpenAI resource |
| `AZURE_OPENAI_KEY` | Credential for that resource |
| `AZURE_OPENAI_DEPLOYMENT` | Model deployment name |
| `PORT` | HTTP port; defaults to 3000 |

Start the service:

```sh
npm start
```

Configure a GitHub webhook to send pull-request events to the service's `/webhook` endpoint using the same webhook secret. Use a disposable repository for initial testing.

Optional flags read by the entry point are `NEURON_ALWAYS_COMMENT`, `NEURON_DEBUG_COMMENTS` and `DEBUG_RENDER`. Comment flags default to true in the current implementation; debug rendering is off unless enabled.

## Operating considerations

The service has authority to make GitHub changes and runs repository/test workflows. Restrict its GitHub credential to the intended repositories and permissions. Keep real credentials in local or deployment secret storage, and review what repository content is sent to the configured model service.

Before exposing it to untrusted repositories or pull requests, review repository authorization, execution isolation, generated-file restrictions and event handling. Webhook signature verification and schema validation alone do not establish that untrusted code can be executed safely.

## Validation and demonstration

The package currently defines a start command, rather than a project-level test command. A useful end-to-end check uses a disposable repository and a synthetic pull request: inspect the selected context, structured response, repeated-comment filtering and generated changes, including an unhelpful model response. Review generated work before accepting it.

No benchmark score or production deployment is claimed here.

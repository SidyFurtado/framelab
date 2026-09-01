---
name: context7
description: Access real-time, version-specific library documentation on-demand via Context7 CLI without persistent MCP overhead.
---

# Context7 Documentation Querying

Use this skill when developing with modern libraries or APIs whose documentation may have evolved beyond the LLM cutoff, or when needing verified up-to-date syntax examples.

## Rules of Engagement (Strict Token Economy)
1. **Primary Sources First**: For Adobe Premiere Pro UXP, Gemini API, OpenAI, and Anthropic, consult official documentation and local workspace references in `docs/` first.
2. **On-Demand Only**: Call Context7 only when working with an external library or framework whose syntax needs verification.
3. **Focused Queries**: Query only the specific topic/hook/method needed. Never request entire documentation sets.
4. **Stop Condition**: Once the exact API signature or snippet is obtained, stop querying immediately.

## Workflow

### 1. Resolve Library ID
```bash
npx ctx7 library <library_name> "<topic>"
```

### 2. Fetch Targeted Documentation
```bash
npx ctx7 docs <library_id> "<specific_method_or_hook>"
```
*Example:*
```bash
npx ctx7 docs /reactjs/react.dev "useEffect cleanup"
```

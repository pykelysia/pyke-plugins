# Skill-only plugin template

Copy this directory to `plugins/<plugin-name>`, replace every `my-skill` and `Your Name` value, and add the plugin to the ZCode, Claude Code, and Codex marketplace manifests at the repository root. The root `plugin.json` follows the portable Agent Plugins specification; the three hidden manifests support individual hosts. Keep `name` and `version` aligned in all plugin manifests and catalogs. Run `node scripts/validate-marketplaces.mjs` before publishing.

#!/bin/bash
# Startup script for Moltbot in Cloudflare Sandbox
# This script:
# 1. Restores config from R2 backup if available
# 2. Configures moltbot from environment variables
# 3. Starts a background sync to backup config to R2
# 4. Starts the gateway

set -e

# Prevent concurrent startup races.
# Multiple Worker requests can trigger container startup simultaneously; without a lock,
# two gateway launches can race and one will fail with "gateway already running" / port in use.
START_LOCK_DIR="/tmp/start-moltbot.lockdir"
START_LOCK_WAIT_SECONDS="${START_LOCK_WAIT_SECONDS:-60}"

if mkdir "$START_LOCK_DIR" >/dev/null 2>&1; then
    # Remove lock on exit (restart/reset kills this process, which triggers the trap).
    trap 'rmdir "$START_LOCK_DIR" 2>/dev/null || true' EXIT
else
    echo "Another moltbot startup is already in progress; waiting for gateway to become ready..."

    waited=0
    while [ "$waited" -lt "$START_LOCK_WAIT_SECONDS" ]; do
        # Check if port is open (bash TCP check). Gateway listens on 18789 when ready.
        if (echo >/dev/tcp/127.0.0.1/18789) >/dev/null 2>&1; then
            echo "Gateway is ready."
            exit 0
        fi
        sleep 1
        waited=$((waited + 1))
    done

    echo "Timed out waiting for gateway readiness after ${START_LOCK_WAIT_SECONDS}s."
    exit 1
fi

# Check if clawdbot gateway is already running - bail early if so
# Note: CLI is still named "clawdbot" until upstream renames it
if pgrep -f "clawdbot gateway" > /dev/null 2>&1; then
    echo "Moltbot gateway is already running, exiting."
    exit 0
fi

# Paths (clawdbot paths are used internally - upstream hasn't renamed yet)
CONFIG_DIR="/root/.clawdbot"
CONFIG_FILE="$CONFIG_DIR/clawdbot.json"
TEMPLATE_DIR="/root/.clawdbot-templates"
TEMPLATE_FILE="$TEMPLATE_DIR/moltbot.json.template"
BACKUP_DIR="/data/moltbot"

echo "Config directory: $CONFIG_DIR"
echo "Backup directory: $BACKUP_DIR"

# Create config directory
mkdir -p "$CONFIG_DIR"

# ============================================================
# RESTORE FROM R2 BACKUP
# ============================================================
# Check if R2 backup exists by looking for clawdbot.json
# The BACKUP_DIR may exist but be empty if R2 was just mounted
# Note: backup structure is $BACKUP_DIR/clawdbot/ and $BACKUP_DIR/skills/

# Helper function to check if R2 backup is newer than local
should_restore_from_r2() {
    local R2_SYNC_FILE="$BACKUP_DIR/.last-sync"
    local LOCAL_SYNC_FILE="$CONFIG_DIR/.last-sync"
    
    # If no R2 sync timestamp, don't restore
    if [ ! -f "$R2_SYNC_FILE" ]; then
        echo "No R2 sync timestamp found, skipping restore"
        return 1
    fi
    
    # If no local sync timestamp, restore from R2
    if [ ! -f "$LOCAL_SYNC_FILE" ]; then
        echo "No local sync timestamp, will restore from R2"
        return 0
    fi
    
    # Compare timestamps
    R2_TIME=$(cat "$R2_SYNC_FILE" 2>/dev/null)
    LOCAL_TIME=$(cat "$LOCAL_SYNC_FILE" 2>/dev/null)
    
    echo "R2 last sync: $R2_TIME"
    echo "Local last sync: $LOCAL_TIME"
    
    # Convert to epoch seconds for comparison
    R2_EPOCH=$(date -d "$R2_TIME" +%s 2>/dev/null || echo "0")
    LOCAL_EPOCH=$(date -d "$LOCAL_TIME" +%s 2>/dev/null || echo "0")
    
    if [ "$R2_EPOCH" -gt "$LOCAL_EPOCH" ]; then
        echo "R2 backup is newer, will restore"
        return 0
    else
        echo "Local data is newer or same, skipping restore"
        return 1
    fi
}

if [ -f "$BACKUP_DIR/clawdbot/clawdbot.json" ]; then
    if should_restore_from_r2; then
        echo "Restoring from R2 backup at $BACKUP_DIR/clawdbot..."
        # Use rsync (instead of cp -a) to avoid hardlink/overwrite edge cases on FUSE mounts.
        # Keep rsync compatible with s3fs by not attempting to preserve timestamps.
        rsync -r --delete --no-times "$BACKUP_DIR/clawdbot/" "$CONFIG_DIR/"
        # Copy the sync timestamp to local so we know what version we have
        cp -f "$BACKUP_DIR/.last-sync" "$CONFIG_DIR/.last-sync" 2>/dev/null || true
        echo "Restored config from R2 backup"
    fi
elif [ -f "$BACKUP_DIR/clawdbot.json" ]; then
    # Legacy backup format (flat structure)
    if should_restore_from_r2; then
        echo "Restoring from legacy R2 backup at $BACKUP_DIR..."
        rsync -r --delete --no-times "$BACKUP_DIR/" "$CONFIG_DIR/"
        cp -f "$BACKUP_DIR/.last-sync" "$CONFIG_DIR/.last-sync" 2>/dev/null || true
        echo "Restored config from legacy R2 backup"
    fi
elif [ -d "$BACKUP_DIR" ]; then
    echo "R2 mounted at $BACKUP_DIR but no backup data found yet"
else
    echo "R2 not mounted, starting fresh"
fi

# Restore skills from R2 backup if available (only if R2 is newer)
SKILLS_DIR="/root/clawd/skills"
if [ -d "$BACKUP_DIR/skills" ] && [ "$(ls -A $BACKUP_DIR/skills 2>/dev/null)" ]; then
    if should_restore_from_r2; then
        echo "Restoring skills from $BACKUP_DIR/skills..."
        mkdir -p "$SKILLS_DIR"
        # Merge skills from backup but keep any skills shipped in the image.
        # This avoids older backups wiping newly added skills on first boot.
        rsync -r --no-times "$BACKUP_DIR/skills/" "$SKILLS_DIR/"
        echo "Restored skills from R2 backup"
    fi
fi

# Normalize legacy skill directory names (underscore -> hyphen) when only the legacy name exists.
# This prevents mismatches where skill frontmatter uses hyphens but the folder uses underscores.
rename_legacy_skill_dir_if_needed() {
    local legacy="$1"
    local canonical="$2"
    if [ -d "$SKILLS_DIR/$legacy" ] && [ ! -d "$SKILLS_DIR/$canonical" ]; then
        echo "Renaming legacy skill dir '$legacy' -> '$canonical'..."
        mv "$SKILLS_DIR/$legacy" "$SKILLS_DIR/$canonical" 2>/dev/null || true
    fi
}
rename_legacy_skill_dir_if_needed "novel_writer" "novel-writer"
rename_legacy_skill_dir_if_needed "xiaohongshu_note_analyzer" "xiaohongshu-note-analyzer"

# If legacy underscore-named skill folders exist alongside canonical hyphenated ones,
# they can "shadow" the intended skill because Telegram commands are underscore-sanitized.
# Preserve legacy copies but stash them under a dot-prefixed folder (pi-coding-agent skips dot dirs).
LEGACY_SKILLS_DIR="$SKILLS_DIR/.legacy"
mkdir -p "$LEGACY_SKILLS_DIR"
SKILL_STASH_TS="$(date -u +"%Y%m%dT%H%M%SZ" 2>/dev/null || date +"%s")"
stash_legacy_skill_dir_if_shadowing() {
    local legacy="$1"
    local canonical="$2"
    if [ -d "$SKILLS_DIR/$legacy" ] && [ -d "$SKILLS_DIR/$canonical" ]; then
        echo "Stashing legacy skill dir '$legacy' (canonical '$canonical' exists)..."
        mv "$SKILLS_DIR/$legacy" "$LEGACY_SKILLS_DIR/${legacy}_${SKILL_STASH_TS}" 2>/dev/null || true
    fi
}
stash_legacy_skill_dir_if_shadowing "novel_writer" "novel-writer"
stash_legacy_skill_dir_if_shadowing "xiaohongshu_note_analyzer" "xiaohongshu-note-analyzer"

# If config file still doesn't exist, create from template
if [ ! -f "$CONFIG_FILE" ]; then
    echo "No existing config found, initializing from template..."
    if [ -f "$TEMPLATE_FILE" ]; then
        cp "$TEMPLATE_FILE" "$CONFIG_FILE"
    else
        # Create minimal config if template doesn't exist
        cat > "$CONFIG_FILE" << 'EOFCONFIG'
{
  "agents": {
    "defaults": {
      "workspace": "/root/clawd"
    }
  },
  "gateway": {
    "port": 18789,
    "mode": "local"
  }
}
EOFCONFIG
    fi
else
    echo "Using existing config"
fi

# ============================================================
# UPDATE CONFIG FROM ENVIRONMENT VARIABLES
# ============================================================
node << 'EOFNODE'
const fs = require('fs');

const configPath = '/root/.clawdbot/clawdbot.json';
console.log('Updating config at:', configPath);
let config = {};

try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
    console.log('Starting with empty config');
}

// Ensure nested objects exist
config.agents = config.agents || {};
config.agents.defaults = config.agents.defaults || {};
config.agents.defaults.model = config.agents.defaults.model || {};
config.gateway = config.gateway || {};
config.channels = config.channels || {};
config.plugins = config.plugins || {};
config.plugins.entries = config.plugins.entries || {};
config.skills = config.skills || {};
config.skills.load = config.skills.load || {};
config.skills.load.extraDirs = Array.isArray(config.skills.load.extraDirs) ? config.skills.load.extraDirs : [];
config.skills.entries = config.skills.entries || {};

// Ensure the default workspace is present. If a restored config points at a missing workspace,
// fall back to /root/clawd (where this image ships workspace skills).
try {
    const ws = typeof config.agents.defaults.workspace === 'string' ? config.agents.defaults.workspace.trim() : '';
    const defaultWs = '/root/clawd';
    if (!ws) {
        config.agents.defaults.workspace = defaultWs;
    } else if (!fs.existsSync(ws)) {
        console.log(`Workspace path does not exist (${ws}); falling back to ${defaultWs}`);
        config.agents.defaults.workspace = defaultWs;
    }
} catch {
    config.agents.defaults.workspace = '/root/clawd';
}

// Always scan the image-shipped skills directory as an extra skills dir.
// This makes workspace-added skills available even when the active workspace is a per-scope sandbox workspace.
if (!config.skills.load.extraDirs.includes('/root/clawd/skills')) {
    config.skills.load.extraDirs.push('/root/clawd/skills');
}

function migrateSkillEntryKey(from, to) {
    const fromKey = typeof from === 'string' ? from.trim() : '';
    const toKey = typeof to === 'string' ? to.trim() : '';
    if (!fromKey || !toKey || fromKey === toKey) return;
    if (!config.skills.entries[fromKey]) return;
    if (config.skills.entries[toKey]) return;
    config.skills.entries[toKey] = config.skills.entries[fromKey];
    delete config.skills.entries[fromKey];
    console.log(`Migrated skills.entries key: ${fromKey} -> ${toKey}`);
}

// Migrate legacy underscored skill names to canonical hyphenated folder names.
migrateSkillEntryKey('xiaohongshu_note_analyzer', 'xiaohongshu-note-analyzer');
migrateSkillEntryKey('novel_writer', 'novel-writer');

// Ensure the XiaoHongShu note analyzer skill is enabled by default,
// without overriding an explicit user disable.
const xhsSkillKey = 'xiaohongshu-note-analyzer';
config.skills.entries[xhsSkillKey] = config.skills.entries[xhsSkillKey] || {};
if (!Object.prototype.hasOwnProperty.call(config.skills.entries[xhsSkillKey], 'enabled')) {
    config.skills.entries[xhsSkillKey].enabled = true;
}

// Slash commands: enable text parsing and (Telegram) native registration by default.
// This makes `/skill ...` (and per-skill commands) usable from Telegram without requiring
// users to manually discover config flags.
config.commands = config.commands || {};
config.commands.text = true;
if (!Object.prototype.hasOwnProperty.call(config.commands, 'native')) {
    config.commands.native = 'auto';
}
if (!Object.prototype.hasOwnProperty.call(config.commands, 'nativeSkills')) {
    config.commands.nativeSkills = 'auto';
}

function enableBundledPlugin(id) {
    if (!id) return;
    const key = String(id).trim();
    if (!key) return;
    config.plugins.entries[key] = config.plugins.entries[key] || {};
    config.plugins.entries[key].enabled = true;
}

// Clean up any broken anthropic provider config from previous runs
// (older versions didn't include required 'name' field)
if (config.models?.providers?.anthropic?.models) {
    const hasInvalidModels = config.models.providers.anthropic.models.some(m => !m.name);
    if (hasInvalidModels) {
        console.log('Removing broken anthropic provider config (missing model names)');
        delete config.models.providers.anthropic;
    }
}



// Gateway configuration
config.gateway.port = 18789;
config.gateway.mode = 'local';
config.gateway.trustedProxies = ['10.1.0.0'];

// Set gateway token if provided
if (process.env.CLAWDBOT_GATEWAY_TOKEN) {
    config.gateway.auth = config.gateway.auth || {};
    config.gateway.auth.token = process.env.CLAWDBOT_GATEWAY_TOKEN;
} else {
    // If a token was previously persisted in clawdbot.json (e.g. restored from R2),
    // remove it so gateway falls back to pairing mode.
    if (config.gateway?.auth?.token) {
        console.log('Removing persisted gateway token (pairing mode)');
        delete config.gateway.auth.token;
        if (Object.keys(config.gateway.auth).length === 0) {
            delete config.gateway.auth;
        }
    }
}

// Allow insecure auth for dev mode
if (process.env.CLAWDBOT_DEV_MODE === 'true') {
    config.gateway.controlUi = config.gateway.controlUi || {};
    config.gateway.controlUi.allowInsecureAuth = true;
}

// Telegram configuration
if (process.env.TELEGRAM_BOT_TOKEN) {
    enableBundledPlugin('telegram');
    config.channels.telegram = config.channels.telegram || {};
    config.channels.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN;
    config.channels.telegram.enabled = true;
    // Telegram UX: register native slash commands (so Telegram treats `/skill`, `/commands`, etc. as bot commands).
    // This does not bypass command allowlists; it only makes commands discoverable in the client UI.
    config.channels.telegram.commands = config.channels.telegram.commands || {};
    if (!Object.prototype.hasOwnProperty.call(config.channels.telegram.commands, 'native')) {
        config.channels.telegram.commands.native = true;
    }
    if (!Object.prototype.hasOwnProperty.call(config.channels.telegram.commands, 'nativeSkills')) {
        config.channels.telegram.commands.nativeSkills = true;
    }
    const telegramDmPolicy = process.env.TELEGRAM_DM_POLICY || 'pairing';
    config.channels.telegram.dmPolicy = telegramDmPolicy;
    if (process.env.TELEGRAM_DM_ALLOW_FROM) {
        // Explicit allowlist: "123,456,789" → ['123', '456', '789']
        config.channels.telegram.allowFrom = process.env.TELEGRAM_DM_ALLOW_FROM.split(',');
    } else if (telegramDmPolicy === 'open') {
        // "open" policy requires allowFrom: ["*"]
        config.channels.telegram.allowFrom = ['*'];
    }
}

// Discord configuration
// Note: Discord uses nested dm.policy, not flat dmPolicy like Telegram
// See: https://github.com/moltbot/moltbot/blob/v2026.1.24-1/src/config/zod-schema.providers-core.ts#L147-L155
if (process.env.DISCORD_BOT_TOKEN) {
    enableBundledPlugin('discord');
    config.channels.discord = config.channels.discord || {};
    config.channels.discord.token = process.env.DISCORD_BOT_TOKEN;
    config.channels.discord.enabled = true;
    const discordDmPolicy = process.env.DISCORD_DM_POLICY || 'pairing';
    config.channels.discord.dm = config.channels.discord.dm || {};
    config.channels.discord.dm.policy = discordDmPolicy;
    // "open" policy requires allowFrom: ["*"]
    if (discordDmPolicy === 'open') {
        config.channels.discord.dm.allowFrom = ['*'];
    }
}

// Slack configuration
if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    enableBundledPlugin('slack');
    config.channels.slack = config.channels.slack || {};
    config.channels.slack.botToken = process.env.SLACK_BOT_TOKEN;
    config.channels.slack.appToken = process.env.SLACK_APP_TOKEN;
    config.channels.slack.enabled = true;
}

// Base URL override (e.g., for Cloudflare AI Gateway)
// Usage: Set AI_GATEWAY_BASE_URL or ANTHROPIC_BASE_URL to your endpoint like:
//   https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic
//   https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/openai
//   https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/openrouter
const baseUrl = (process.env.AI_GATEWAY_BASE_URL || process.env.OPENAI_BASE_URL || process.env.ANTHROPIC_BASE_URL || '').replace(/\/+$/, '');

// Avoid regex literals here: we've seen bad deploys where escaping changes caused syntax errors.
let lastPathSegment = '';
try {
    const url = new URL(baseUrl);
    lastPathSegment = url.pathname.split('/').filter(Boolean).pop() || '';
} catch {
    lastPathSegment = baseUrl.split('/').filter(Boolean).pop() || '';
}

const isCustomProvider = lastPathSegment.startsWith('custom-') && lastPathSegment.length > 'custom-'.length;
const isOpenRouterGateway = lastPathSegment === 'openrouter' || lastPathSegment === 'custom-openrouter';
const isOpenAIGateway = lastPathSegment === 'openai' || isOpenRouterGateway || isCustomProvider;

// Direct OpenRouter (no AI Gateway): OpenAI-compatible endpoint
const openRouterBaseUrl = (process.env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const hasOpenRouterApiKey = Boolean(process.env.OPENROUTER_API_KEY?.trim());
const openRouterPrimaryModel = (process.env.OPENROUTER_PRIMARY_MODEL || process.env.OPENROUTER_MODEL || 'openrouter/auto').trim();
const openRouterModelsEnv = (process.env.OPENROUTER_MODELS || '').trim();

function parseCommaList(value) {
    if (!value) return [];
    return String(value)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
}

function uniq(list) {
    const seen = new Set();
    const out = [];
    for (const item of list) {
        if (!seen.has(item)) {
            seen.add(item);
            out.push(item);
        }
    }
    return out;
}

if (isOpenAIGateway || (hasOpenRouterApiKey && !baseUrl)) {
    // Create custom openai provider config with baseUrl override
    // Omit apiKey so moltbot falls back to OPENAI_API_KEY env var
    const effectiveBaseUrl = hasOpenRouterApiKey && !baseUrl ? openRouterBaseUrl : baseUrl;
    const isOpenRouter = isOpenRouterGateway || (hasOpenRouterApiKey && !baseUrl) || effectiveBaseUrl.includes('openrouter.ai');

    console.log('Configuring OpenAI-compatible provider with base URL:', effectiveBaseUrl);
    config.models = config.models || {};
    config.models.providers = config.models.providers || {};
    const existingOpenAIProvider = (config.models.providers && config.models.providers.openai) ? config.models.providers.openai : {};
    const desiredApi = (isOpenRouter || isCustomProvider) ? 'openai-completions' : 'openai-responses';

    let desiredModels = null;
    if (isOpenRouter) {
        // If the user explicitly provides OPENROUTER_MODELS/OPENROUTER_PRIMARY_MODEL, we will honor it.
        // Otherwise, keep any existing model list and primary selection to avoid overwriting manual config on restart.
        const wantsOverrideModels = Boolean(openRouterModelsEnv);
        const wantsOverridePrimary = Boolean((process.env.OPENROUTER_PRIMARY_MODEL || process.env.OPENROUTER_MODEL || '').trim());

        const existingPrimary = (config.agents?.defaults?.model?.primary || '').trim();
        const existingPrimaryModelId = existingPrimary.startsWith('openai/') ? existingPrimary.slice('openai/'.length) : '';

        const modelsFromEnv = uniq([
            ...parseCommaList(openRouterModelsEnv),
            openRouterPrimaryModel,
        ]);

        if (wantsOverrideModels || wantsOverridePrimary) {
            desiredModels = modelsFromEnv.map((id) => ({
                id,
                name: id === 'openrouter/auto' ? 'OpenRouter Auto' : id,
                contextWindow: 200000,
            }));
        } else if (Array.isArray(existingOpenAIProvider.models) && existingOpenAIProvider.models.length > 0) {
            // Keep existing configured models.
            desiredModels = existingOpenAIProvider.models;
        } else if (existingPrimaryModelId) {
            desiredModels = uniq(['openrouter/auto', existingPrimaryModelId]).map((id) => ({
                id,
                name: id === 'openrouter/auto' ? 'OpenRouter Auto' : id,
                contextWindow: 200000,
            }));
        } else {
            desiredModels = [{ id: 'openrouter/auto', name: 'OpenRouter Auto', contextWindow: 200000 }];
        }
    } else {
        desiredModels = [
            { id: 'gpt-5.2', name: 'GPT-5.2', contextWindow: 200000 },
            { id: 'gpt-5', name: 'GPT-5', contextWindow: 200000 },
            { id: 'gpt-4.5-preview', name: 'GPT-4.5 Preview', contextWindow: 128000 },
        ];
    }

    config.models.providers.openai = {
        ...existingOpenAIProvider,
        baseUrl: effectiveBaseUrl,
        api: desiredApi,
        models: desiredModels,
    };

    // If AI Gateway "Authenticated Gateway" is enabled, include the auth header (optional).
    // See: https://developers.cloudflare.com/ai-gateway/features/authenticated-gateway/
    if (process.env.AI_GATEWAY_AUTH_TOKEN && effectiveBaseUrl.includes('gateway.ai.cloudflare.com')) {
        config.models.providers.openai.headers = config.models.providers.openai.headers || {};
        // Use string concatenation (avoid `${...}` so bash can't accidentally expand it if heredoc quoting is broken).
        config.models.providers.openai.headers['cf-aig-authorization'] = 'Bearer ' + process.env.AI_GATEWAY_AUTH_TOKEN;
    }

    // For OpenRouter, prefer OPENROUTER_API_KEY (so users don't have to set OPENAI_API_KEY).
    // For AI Gateway OpenAI/OpenRouter, the worker maps AI_GATEWAY_API_KEY -> OPENAI_API_KEY, so we omit apiKey here.
    if (isOpenRouter && hasOpenRouterApiKey && !process.env.OPENAI_API_KEY?.trim()) {
        config.models.providers.openai.apiKey = process.env.OPENROUTER_API_KEY;
    }

    // Add models to the allowlist so they appear in /models
    config.agents.defaults.models = config.agents.defaults.models || {};
    if (isOpenRouter) {
        const wantsOverridePrimary = Boolean((process.env.OPENROUTER_PRIMARY_MODEL || process.env.OPENROUTER_MODEL || '').trim());
        const wantsOverrideModels = Boolean(openRouterModelsEnv);

        // Populate allowlist entries for the configured OpenRouter models (best-effort).
        const providerModelIds = Array.isArray(config.models.providers.openai.models)
            ? config.models.providers.openai.models.map(m => m && m.id).filter(Boolean)
            : [];

        for (const id of providerModelIds) {
            const key = 'openai/' + id;
            if (!config.agents.defaults.models[key]) {
                config.agents.defaults.models[key] = { alias: id === 'openrouter/auto' ? 'OpenRouter Auto' : id };
            }
        }

        // Only set primary if:
        // - user explicitly asked for it via env, OR
        // - it's currently missing.
        if (wantsOverridePrimary || !config.agents.defaults.model.primary) {
            config.agents.defaults.model.primary = 'openai/' + (openRouterPrimaryModel || 'openrouter/auto');
        } else if (wantsOverrideModels) {
            // If user specified OPENROUTER_MODELS but not primary, keep existing primary if it still exists;
            // otherwise fall back to first model.
            const primary = String(config.agents.defaults.model.primary || '');
            const primaryId = primary.startsWith('openai/') ? primary.slice('openai/'.length) : '';
            if (primaryId && providerModelIds.includes(primaryId)) {
                // keep
            } else if (providerModelIds.length > 0) {
                config.agents.defaults.model.primary = 'openai/' + providerModelIds[0];
            } else {
                config.agents.defaults.model.primary = 'openai/openrouter/auto';
            }
        }
    } else {
        config.agents.defaults.models['openai/gpt-5.2'] = { alias: 'GPT-5.2' };
        config.agents.defaults.models['openai/gpt-5'] = { alias: 'GPT-5' };
        config.agents.defaults.models['openai/gpt-4.5-preview'] = { alias: 'GPT-4.5' };
        config.agents.defaults.model.primary = 'openai/gpt-5.2';
    }
} else if (baseUrl) {
    console.log('Configuring Anthropic provider with base URL:', baseUrl);
    config.models = config.models || {};
    config.models.providers = config.models.providers || {};
    const providerConfig = {
        baseUrl: baseUrl,
        api: 'anthropic-messages',
        models: [
            { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5', contextWindow: 200000 },
            { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', contextWindow: 200000 },
            { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', contextWindow: 200000 },
        ]
    };
    // Include API key in provider config if set (required when using custom baseUrl)
    if (process.env.ANTHROPIC_API_KEY) {
        providerConfig.apiKey = process.env.ANTHROPIC_API_KEY;
    }
    config.models.providers.anthropic = providerConfig;
    // Add models to the allowlist so they appear in /models
    config.agents.defaults.models = config.agents.defaults.models || {};
    config.agents.defaults.models['anthropic/claude-opus-4-5-20251101'] = { alias: 'Opus 4.5' };
    config.agents.defaults.models['anthropic/claude-sonnet-4-5-20250929'] = { alias: 'Sonnet 4.5' };
    config.agents.defaults.models['anthropic/claude-haiku-4-5-20251001'] = { alias: 'Haiku 4.5' };
    config.agents.defaults.model.primary = 'anthropic/claude-opus-4-5-20251101';
} else {
    // Default to Anthropic without custom base URL (uses built-in pi-ai catalog)
    config.agents.defaults.model.primary = 'anthropic/claude-opus-4-5';
}

// Write updated config
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('Configuration updated successfully');
console.log('Config:', JSON.stringify(config, null, 2));
EOFNODE

# ============================================================
# PATCH CLAWDBOT: SKILL COMMANDS + TELEGRAM NATIVE COMMANDS
# ============================================================
# Telegram (and other chat UIs) often surface skill command names with "-" (skill name)
# while the internal command name is sanitized to "_" (Telegram native command restriction).
# Upstream currently matches direct "/skillname" commands strictly by entry.name, which
# makes "/foo-bar" fail when the registered command is "/foo_bar".
#
# Telegram native commands also set CommandSource="native", which upstream uses to disable
# text command parsing entirely. That breaks skill commands (and /skill) when invoked via
# Telegram's command UI. We patch the upstream check so native commands still support text
# command parsing when `commands.text` is enabled (default).
#
# Patch the installed clawdbot package in-place (idempotent) so direct skill commands use
# the same normalization logic as "/skill <name> ...".
echo "Patching clawdbot skill command behavior if needed..."
set +e
node <<'EOFPATCH'
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

function resolveGlobalPackageDir(packageName) {
  try {
    const npmRoot = childProcess.execSync('npm root -g', { encoding: 'utf8' }).trim();
    const candidate = path.join(npmRoot, packageName);
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    // ignore
  }
  return null;
}

function patchSkillCommandsFile(packageDir) {
  const filePath = path.join(packageDir, 'dist', 'auto-reply', 'skill-commands.js');
  if (!fs.existsSync(filePath)) return { status: 'missing', filePath };

  const marker = 'MOLTBOT_PATCH_SKILL_COMMAND_ALIASES_V1';
  const needle =
    'const command = params.skillCommands.find((entry) => entry.name.toLowerCase() === commandName);';

  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return { status: 'read_failed', filePath, error };
  }

  if (content.includes(marker)) return { status: 'already_patched', filePath };
  if (!content.includes(needle)) return { status: 'pattern_not_found', filePath };

  const replacement = `// ${marker}: treat "-" and "_" equivalently for direct /skillname invocations.\n    const command = findSkillCommand(params.skillCommands, commandName);`;
  const next = content.replace(needle, replacement);

  try {
    fs.writeFileSync(filePath, next, 'utf8');
  } catch (error) {
    return { status: 'write_failed', filePath, error };
  }

  return { status: 'patched', filePath };
}

function patchCommandsRegistryFile(packageDir) {
  const filePath = path.join(packageDir, 'dist', 'auto-reply', 'commands-registry.js');
  if (!fs.existsSync(filePath)) return { status: 'missing', filePath };

  const marker = 'MOLTBOT_PATCH_NATIVE_COMMANDS_ALLOW_TEXT_V1';
  const needle = 'if (params.commandSource === "native")\n        return false;';

  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return { status: 'read_failed', filePath, error };
  }

  if (content.includes(marker)) return { status: 'already_patched', filePath };
  if (!content.includes(needle)) return { status: 'pattern_not_found', filePath };

  const replacement = `// ${marker}: allow text command parsing even for native-command updates (Telegram native commands).\n    // Command handlers still check authorization (CommandAuthorized/isAuthorizedSender).\n    // If you want to fully disable text commands, set config.commands.text = false.\n    `;
  const next = content.replace(needle, replacement);

  try {
    fs.writeFileSync(filePath, next, 'utf8');
  } catch (error) {
    return { status: 'write_failed', filePath, error };
  }

  return { status: 'patched', filePath };
}

const packageNames = ['clawdbot', 'openclaw'];
let didAnything = false;
for (const packageName of packageNames) {
  const dir = resolveGlobalPackageDir(packageName);
  if (!dir) continue;

  const results = [
    { label: 'skill-commands', ...patchSkillCommandsFile(dir) },
    { label: 'commands-registry', ...patchCommandsRegistryFile(dir) },
  ];

  for (const result of results) {
    if (result.status === 'patched' || result.status === 'already_patched') didAnything = true;
    console.log(`[patch] ${packageName} ${result.label}: ${result.status} (${result.filePath})`);
    if (result.error) console.log(`[patch] ${packageName} ${result.label}: ${String(result.error)}`);
  }
}
if (!didAnything) {
  console.log('[patch] No global clawdbot/openclaw install found or patch not applicable.');
}
EOFPATCH
set -e

# ============================================================
# START GATEWAY
# ============================================================
# Note: R2 backup sync is handled by the Worker's cron trigger
echo "Starting Moltbot Gateway..."
echo "Gateway will be available on port 18789"

# Clean up stale lock files
rm -f /tmp/clawdbot-gateway.lock 2>/dev/null || true
rm -f "$CONFIG_DIR/gateway.lock" 2>/dev/null || true

# Default bind mode.
# Note: In Cloudflare Sandbox, the Worker reaches the gateway over the container network, so we must bind beyond loopback.
BIND_MODE="${CLAWDBOT_BIND_MODE:-lan}"
echo "Dev mode: ${CLAWDBOT_DEV_MODE:-false}, Bind mode: $BIND_MODE"

if [ -n "$CLAWDBOT_GATEWAY_TOKEN" ]; then
    echo "Starting gateway with token auth..."
    clawdbot gateway --port 18789 --verbose --allow-unconfigured --bind "$BIND_MODE" --token "$CLAWDBOT_GATEWAY_TOKEN"
else
    echo "Starting gateway with device pairing (no token)..."
    clawdbot gateway --port 18789 --verbose --allow-unconfigured --bind "$BIND_MODE"
fi

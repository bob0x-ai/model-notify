import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, TurnEndEvent, ExtensionContext } from "@mariozechner/pi-coding-agent";

type OpenClawConfig = {
  channels?: {
    telegram?: {
      botToken?: string;
      chatId?: string;
      accounts?: Record<string, { botToken?: string; chatId?: string }>;
    };
  };
  logging?: {
    file?: string;
  };
};

type AuthProfileStore = {
  lastGood?: Record<string, string>;
};

type LastReported = {
  signature?: string;
  runKey?: string;
};

const warned = new Set<string>();
let lastReported: LastReported = {};

function warnOnce(key: string, message: string) {
  if (warned.has(key)) {
    return;
  }
  warned.add(key);
  console.warn(message);
}

function resolveStateDir(): string {
  const fromEnv = process.env.OPENCLAW_STATE_DIR?.trim();
  if (fromEnv) {
    return expandHome(fromEnv);
  }
  return path.join(os.homedir(), ".openclaw");
}

function resolveAgentDir(): string {
  const fromEnv = process.env.OPENCLAW_AGENT_DIR?.trim() || process.env.PI_CODING_AGENT_DIR?.trim();
  if (fromEnv) {
    return expandHome(fromEnv);
  }
  return path.join(resolveStateDir(), "agents", "main", "agent");
}

function expandHome(input: string): string {
  if (!input.startsWith("~")) {
    return input;
  }
  const home = os.homedir();
  if (input === "~") {
    return home;
  }
  return path.join(home, input.slice(2));
}

function normalizeProviderId(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "z.ai" || normalized === "z-ai") {
    return "zai";
  }
  if (normalized === "opencode-zen") {
    return "opencode";
  }
  if (normalized === "qwen") {
    return "qwen-portal";
  }
  if (normalized === "kimi-code") {
    return "kimi-coding";
  }
  return normalized;
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch (err) {
    return null;
  }
}

async function resolveTelegramConfig(): Promise<{
  token?: string;
  chatId?: string;
}> {
  const stateDir = resolveStateDir();
  const configPath = path.join(stateDir, "openclaw.json");
  const config = await readJson<OpenClawConfig>(configPath);

  const envChatId =
    process.env.OPENCLAW_TELEGRAM_CHAT_ID?.trim() ||
    process.env.TELEGRAM_CHAT_ID?.trim() ||
    process.env.TELEGRAM_NOTIFY_CHAT_ID?.trim();

  const envToken =
    process.env.OPENCLAW_TELEGRAM_BOT_TOKEN?.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim();

  const telegram = config?.channels?.telegram;
  const account = telegram?.accounts?.main;

  const token = envToken || account?.botToken || telegram?.botToken;
  const chatId =
    envChatId || account?.chatId || telegram?.chatId || (await resolveTelegramChatIdFromLog(config));

  return { token, chatId };
}

function resolveLogPath(config?: OpenClawConfig): string {
  const fromConfig = config?.logging?.file?.trim();
  if (fromConfig) {
    return expandHome(fromConfig);
  }
  return path.join(resolveStateDir(), "workspace", "logs", "openclaw.log");
}

async function readLogTail(filePath: string, bytes: number): Promise<string> {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const stats = await handle.stat();
      const start = Math.max(0, stats.size - bytes);
      const length = stats.size - start;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

function extractChatIdFromLogLine(line: string): string | undefined {
  let text = line;
  if (line.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const maybeText = parsed["1"];
      if (typeof maybeText === "string") {
        text = maybeText;
      }
    } catch {
      // fall back to raw line
    }
  }

  if (!text.includes("telegram update:")) {
    return undefined;
  }
  const match = text.match(/telegram update: ({.*})/);
  if (!match) {
    return undefined;
  }
  try {
    const payload = JSON.parse(match[1]) as {
      message?: { chat?: { id?: number | string } };
      channel_post?: { chat?: { id?: number | string } };
    };
    const id = payload.message?.chat?.id ?? payload.channel_post?.chat?.id;
    if (typeof id === "number") {
      return String(id);
    }
    if (typeof id === "string" && id.trim()) {
      return id.trim();
    }
  } catch {
    // fall through to escaped match
  }
  const fallbackMatch = text.match(/\"chat\":\\{\\\"id\\\":(-?\\d+)/);
  if (fallbackMatch) {
    return fallbackMatch[1];
  }
  return undefined;
}

async function resolveTelegramChatIdFromLog(
  config?: OpenClawConfig,
): Promise<string | undefined> {
  const logPath = resolveLogPath(config);
  const tail = await readLogTail(logPath, 512 * 1024);
  if (!tail) {
    return undefined;
  }
  const lines = tail.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const chatId = extractChatIdFromLogLine(lines[i]);
    if (chatId) {
      return chatId;
    }
  }
  return undefined;
}

async function resolveLastGoodProfile(provider: string): Promise<string | undefined> {
  const agentDir = resolveAgentDir();
  const storePath = path.join(agentDir, "auth-profiles.json");
  const store = await readJson<AuthProfileStore>(storePath);
  if (!store?.lastGood) {
    return undefined;
  }
  const normalized = normalizeProviderId(provider);
  return store.lastGood[normalized] ?? store.lastGood[provider];
}

async function sendTelegramMessage(text: string): Promise<void> {
  const { token, chatId } = await resolveTelegramConfig();
  if (!token) {
    warnOnce("telegram-token", "[model-notify] Missing Telegram bot token.");
    return;
  }
  if (!chatId) {
    warnOnce(
      "telegram-chat",
      "[model-notify] Missing Telegram chat id. Set OPENCLAW_TELEGRAM_CHAT_ID to enable notifications.",
    );
    return;
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    warnOnce(
      `telegram-send-${response.status}`,
      `[model-notify] Telegram sendMessage failed (${response.status}): ${body}`,
    );
  }
}

function buildSignature(params: {
  provider: string;
  modelId: string;
  profileId?: string;
}): string {
  const profile = params.profileId ? params.profileId : "unknown";
  return `${params.provider}/${params.modelId}@${profile}`;
}

async function handleTurnEnd(event: TurnEndEvent, ctx: ExtensionContext) {
  const model = ctx.model;
  if (!model) {
    return;
  }
  const provider = model.provider;
  const modelId = model.id;
  if (!provider || !modelId) {
    return;
  }

  const profileId = await resolveLastGoodProfile(provider);
  const signature = buildSignature({ provider, modelId, profileId });
  const runKey = `${ctx.sessionManager.getSessionId()}:${event.turnIndex}`;

  if (lastReported.signature === signature) {
    lastReported.runKey = runKey;
    return;
  }

  const profileLabel = profileId ? ` @ ${profileId}` : " @ unknown";
  const message = `Model switch -> ${provider}/${modelId}${profileLabel}`;

  await sendTelegramMessage(message);
  lastReported = { signature, runKey };
}

export default function modelNotifyExtension(api: ExtensionAPI): void {
  api.on("turn_end", (event, ctx) => {
    void handleTurnEnd(event, ctx);
  });
}

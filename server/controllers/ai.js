const AISettings = require("../models/AISettings");
const logger = require("../utils/logger");

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OLLAMA_URL = "http://localhost:11434";

const SYSTEM_PROMPT = process.env.AI_SYSTEM_PROMPT || `You are a Linux command generator assistant. Your job is to generate appropriate Linux/Unix shell commands based on user requests.

Rules:
1. Return ONLY the command(s), no explanations or markdown formatting
2. If multiple commands are needed, separate them with && or ;
3. Prefer safe, commonly available commands
4. If the request is unclear, provide the most likely intended command
5. For dangerous operations, use safer alternatives when possible
6. Always assume the user wants commands for a modern Linux system

Examples:
User: "list all files"
Response: ls -la

User: "find large files"
Response: find . -type f -size +100M -exec ls -lh {} + | sort -k5 -hr

User: "check memory usage"
Response: free -h && top -o %MEM -n 1`;

const getProviderConfig = (settings) => {
    const provider = settings.provider;
    
    if (provider === "openai") {
        return {
            baseUrl: OPENAI_BASE_URL,
            headers: authHeaders(settings.apiKey),
            requiresApiKey: true,
            requiresApiUrl: false,
        };
    }
    
    if (provider === "openai_compatible") {
        return {
            baseUrl: normalizeUrl(settings.apiUrl),
            headers: authHeaders(settings.apiKey),
            requiresApiKey: true,
            requiresApiUrl: true,
        };
    }
    
    if (provider === "ollama") {
        return {
            baseUrl: normalizeUrl(settings.apiUrl) || DEFAULT_OLLAMA_URL,
            headers: { "Content-Type": "application/json" },
            requiresApiKey: false,
            requiresApiUrl: false,
        };
    }
    
    return null;
};

const validateProviderConfig = (settings, config) => {
    if (!config) return { code: 400, message: "Unsupported provider" };
    if (config.requiresApiKey && !settings.apiKey) {
        const name = settings.provider === "openai" ? "OpenAI" : "OpenAI Compatible";
        return { code: 400, message: `${name} API key not configured` };
    }
    if (config.requiresApiUrl && !settings.apiUrl) {
        return { code: 400, message: "OpenAI Compatible API URL not configured" };
    }
    return null;
};

module.exports.getAISettings = async () => {
    const settings = await getOrCreateSettings();
    return sanitizeSettingsResponse(settings);
};

module.exports.updateAISettings = async (updateData) => {
    const { enabled, provider, model, apiKey, apiUrl } = updateData;
    const settings = await getOrCreateSettings();

    const updatePayload = {};
    if (enabled !== undefined) updatePayload.enabled = enabled;
    if (provider !== undefined) updatePayload.provider = provider;
    if (model !== undefined) updatePayload.model = model;
    if (apiUrl !== undefined) updatePayload.apiUrl = apiUrl;
    if (apiKey !== undefined) updatePayload.apiKey = apiKey === "" ? null : apiKey;

    const settingsId = settings.dataValues ? settings.dataValues.id : settings.id;
    await AISettings.update(updatePayload, { where: { id: settingsId } });

    const updatedSettings = await AISettings.findOne();
    return sanitizeSettingsResponse(updatedSettings);
};

module.exports.testAIConnection = async () => {
    const settings = await AISettings.findOne();

    if (!settings || !settings.enabled) return { code: 400, message: "AI is not enabled" };
    if (!settings.provider) return { code: 400, message: "No AI provider configured" };
    if (!settings.model) return { code: 400, message: "No AI model configured" };

    try {
        if (settings.provider === "openai") {
            if (!settings.apiKey) return { code: 400, message: "OpenAI API key not configured" };

            const response = await fetch("https://api.openai.com/v1/models", {
                headers: {
                    "Authorization": `Bearer ${settings.apiKey}`,
                    "Content-Type": "application/json",
                },
            });

            if (!response.ok) return { code: 500, message: `OpenAI API error: ${response.status}` };

            const data = await response.json();
            const modelExists = data.data.some(model => model.id === settings.model);

            if (!modelExists) return {
                code: 400,
                message: `Configured model "${settings.model}" not found in your OpenAI account`,
            };
        } else if (settings.provider === "ollama") {
            let ollamaUrl = settings.apiUrl || "http://localhost:11434";
            ollamaUrl = ollamaUrl.replace(/\/+$/, "");

            const response = await fetch(`${ollamaUrl}/api/tags`, {
                method: "GET",
                headers: {
                    "Content-Type": "application/json",
                },
            });

            if (!response.ok) return { code: 500, message: `Ollama API error: ${response.status}` };

            const data = await response.json();
            const models = data.models ? data.models.map(model => model.name) : [];

            if (!models.includes(settings.model)) return {
                code: 400,
                message: `Configured model "${settings.model}" not found in Ollama`,
            };
        } else if (settings.provider === "openai_compatible") {

		if (!settings.apiUrl) return { code: 400, message: "OpenAI Compatible API URL not configured" };
        if (!settings.apiKey) return { code: 400, message: "OpenAI Compatible API key not configured" };

            const response = await fetch(`${settings.apiUrl}/models`, {
                headers: {
                    "Authorization": `Bearer ${settings.apiKey}`,
                    "Content-Type": "application/json",
                },
            });

            if (!response.ok) return { code: 500, message: `OpenAI API error: ${response.status}` };

            const data = await response.json();
            const modelExists = data.data.some(model => model.id === settings.model);

            if (!modelExists) return {
                code: 400,
                message: `Configured model "${settings.model}" not found in OpenAI Compatible API`,
            };
        }

        return { success: true, message: "Connection test successful" };
    } catch (error) {
        logger.error("AI connection test failed", { error: error.message, stack: error.stack });
        return { code: 500, message: `Connection test failed: ${error.message}` };
    }
};

const fetchModelsForProvider = async (settings, config) => {
    const provider = settings.provider;
    
    try {
        if (provider === "ollama") {
            const response = await fetch(`${config.baseUrl}/api/tags`, {
                method: "GET",
                headers: config.headers,
            });
            
            if (!response.ok) return { error: { code: 500, message: `Ollama API error: ${response.status}` } };
            
            const data = await response.json();
            const ollamaModels = data.models ? data.models.map(model => model.name).filter(name => name) : [];

            return { models: ollamaModels || [] };
        } catch (error) {
            return { models: [] };
        }
    } else if (settings.provider === "openai") {
        if (!settings.apiKey) return { code: 400, message: "OpenAI API key not configured" };

        try {
            const response = await fetch("https://api.openai.com/v1/models", {
                headers: {
                    "Authorization": `Bearer ${settings.apiKey}`,
                    "Content-Type": "application/json",
                },
            });

            if (!response.ok) return { code: 500, message: "Failed to fetch models from OpenAI" };

            const data = await response.json();

            const chatModels = data.data
                .filter(model =>
                    model.id.includes("gpt") &&
                    !model.id.includes("instruct") &&
                    !model.id.includes("edit") &&
                    !model.id.includes("embedding") &&
                    !model.id.includes("whisper") &&
                    !model.id.includes("tts") &&
                    !model.id.includes("dall-e"),
                )
                .map(model => model.id)
                .sort();

            return { models: chatModels || [] };
        } catch (error) {
            logger.error("Error fetching OpenAI models", { error: error.message });
            return { models: [] };
        }
    } else if (settings.provider === "openai_compatible") {
		if (!settings.apiUrl) return { code: 400, message: "OpenAI Compatible API URL not configured" };
        if (!settings.apiKey) return { code: 400, message: "OpenAI Compatible API key not configured" };

        try {
            const response = await fetch(settings.apiUrl, {
                headers: {
                    "Authorization": `Bearer ${settings.apiKey}`,
                    "Content-Type": "application/json",
                },
            });

            if (!response.ok) return { code: 500, message: "Failed to fetch models from OpenAI Compatible API" };

            const data = await response.json();

            const chatModels = data.models ? data.models.map(model => model.name).filter(name => name) : [];

            return { models: chatModels || [] };
        } catch (error) {
            console.error("Error fetching OpenAI Compatible API models:", error);
            return { models: [] };
        }
    } else {
        return { code: 400, message: "Unsupported provider" };
    }
};

module.exports.generateCommand = async (prompt) => {
    const settings = await AISettings.findOne();

    if (!settings || !settings.enabled) return { code: 400, message: "AI is not enabled" };
    if (!settings.provider || !settings.model) return { code: 400, message: "AI not properly configured" };

    let command;
    if (settings.provider === "openai") {
        command = await generateOpenAICommand(prompt, settings);
    } else if (settings.provider === "openai_compatible") {
        command = await generateOllamaCommand(prompt, settings);
    } else if (settings.provider === "ollama") {
        command = await generateOllamaCommand(prompt, settings);
    } else {
        return { code: 400, message: "Unsupported AI provider" };
    }

    const command = settings.provider === "ollama"
        ? await generateOllamaCommand(prompt, settings, systemPrompt, config)
        : await generateOpenAICommand(prompt, settings, systemPrompt, config);

    return { command };
};

const generateOpenAICommand = async (prompt, settings) => {
    if (!settings.apiKey) throw new Error("OpenAI API key not configured");

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: config.headers,
        body: JSON.stringify({
            model: settings.model,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: prompt },
            ],
            max_tokens: 150,
            temperature: 0.3,
            stop: ["\n\n"],
        }),
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(`API error: ${error.error?.message || response.status}`);
    }

    const data = await response.json();
    return parseAIResponse(data.choices[0]?.message?.content?.trim());
};

const generateOllamaCommand = async (prompt, settings) => {
    let ollamaUrl = settings.apiUrl || "http://localhost:11434";
    ollamaUrl = ollamaUrl.replace(/\/+$/, "");

    const response = await fetch(`${ollamaUrl}/api/chat`, {
        method: "POST",
        headers: config.headers,
        body: JSON.stringify({
            model: settings.model,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: prompt },
            ],
            stream: false,
            options: {
                temperature: 0.3,
                num_predict: 150,
                stop: ["\n\n"],
            },
        }),
    });

    if (!response.ok) throw new Error(`Ollama API error: ${response.status}`);

    const data = await response.json();
    return parseAIResponse(data.message?.content?.trim());
};

const parseAIResponse = (response) => {
    if (!response) return "echo 'No command generated'";

    let clean = response.replace(/```(?:bash|sh|shell)?\n?/g, "").replace(/```/g, "");

    const responseMatch = clean.match(/Response:\s*(.+?)(?:\n|$)/i);
    if (responseMatch) return responseMatch[1].trim().replace(/[\r\n]+$/, "");

    if (clean.toLowerCase().startsWith("user:")) return "echo 'Command not properly generated'";

    const lines = clean.split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length > 1) {
        const cmd = lines.find(l => !l.toLowerCase().startsWith("user:") && !l.toLowerCase().startsWith("response:"));
        if (cmd) return cmd.trim().replace(/[\r\n]+$/, "");
    }

    if (clean.toLowerCase().startsWith("response:")) return "echo 'Command not properly generated'";

    return clean.trim().replace(/[\r\n]+$/, "") || "echo 'No command generated'";
};

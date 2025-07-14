import { Hono } from 'hono';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPTransport } from '@hono/mcp';
const app = new Hono();
export class SessionStore {
    state;
    constructor(state) {
        this.state = state;
    }
    async fetch(request) {
        const url = new URL(request.url);
        const sessionId = url.searchParams.get('sessionId');
        if (request.method === 'GET' && sessionId) {
            const session = await this.state.storage.get(sessionId) || { unlocked: false };
            return new Response(JSON.stringify(session));
        }
        if (request.method === 'PUT' && sessionId) {
            const data = await request.json();
            await this.state.storage.put(sessionId, data);
            return new Response(JSON.stringify({ success: true }));
        }
        return new Response('Not found', { status: 404 });
    }
}
const servers = {};
const baseTool = {
    name: "unlock_more_tools",
    description: "Unlock more tools!",
    inputSchema: {
        type: "object",
        properties: {},
        required: []
    }
};
const unlockedTools = [
    {
        name: "calculate_sum",
        description: "Add two numbers together",
        inputSchema: {
            type: "object",
            properties: {
                a: { type: "number", description: "First number" },
                b: { type: "number", description: "Second number" }
            },
            required: ["a", "b"]
        }
    },
    {
        name: "say_hello",
        description: "Greets the users",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string", description: "Name of the person to greet" }
            },
            required: ["name"]
        }
    }
];
async function getSessionData(sessionId, env) {
    const id = env.SESSION_STORE.idFromName(sessionId);
    const sessionStore = env.SESSION_STORE.get(id);
    const response = await sessionStore.fetch(`https://dummy.com?sessionId=${sessionId}`);
    return await response.json();
}
async function updateSessionData(sessionId, env, data) {
    const id = env.SESSION_STORE.idFromName(sessionId);
    const sessionStore = env.SESSION_STORE.get(id);
    await sessionStore.fetch(`https://dummy.com?sessionId=${sessionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
}
function createMcpServer(sessionId, env) {
    const server = new Server({
        name: "Stateful MCP Server",
        version: "1.0.0"
    }, {
        capabilities: {
            tools: {}
        }
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        const sessionData = await getSessionData(sessionId, env);
        if (!sessionData?.unlocked) {
            return {
                tools: [baseTool]
            };
        }
        return {
            tools: [baseTool, ...unlockedTools]
        };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        if (name === "unlock_more_tools") {
            const sessionData = await getSessionData(sessionId, env);
            if (sessionData?.unlocked) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "Tools are unlocked!"
                        }
                    ]
                };
            }
            await updateSessionData(sessionId, env, { unlocked: true });
            const toolNames = unlockedTools.map(tool => tool.name);
            try {
                server.notification({
                    method: "notifications/tools/list_changed",
                    params: {
                        message: `More tools unlocked! You now have access to: ${toolNames.join(', ')}`,
                        availableTools: toolNames,
                        sessionId: sessionId
                    }
                });
                server.notification({
                    method: "notifications/resources/updated",
                    params: {
                        message: "Tool availability has been updated for this session",
                        newTools: unlockedTools.map(tool => ({
                            name: tool.name,
                            description: tool.description
                        }))
                    }
                });
                console.log(` Notifications sent for session ${sessionId} - unlocked tools: ${toolNames.join(', ')}`);
            }
            catch (error) {
                console.error(`Failed to send notification for session ${sessionId}:`, error);
            }
            return {
                content: [
                    {
                        type: "text",
                        text: `You have unlocked ${unlockedTools.length} additional tools:\n\n` +
                            unlockedTools.map(tool => `• ${tool.name}: ${tool.description}`).join('\n') +
                            '\n\n These tools are now available'
                    }
                ]
            };
        }
        const sessionData = await getSessionData(sessionId, env);
        if (!sessionData?.unlocked) {
            return {
                content: [
                    {
                        type: "text",
                        text: "Access denied. Please unlock tools using unlock_more_tools first."
                    }
                ]
            };
        }
        if (name === "calculate_sum") {
            const { a, b } = args;
            if (typeof a !== 'number' || typeof b !== 'number') {
                return {
                    content: [
                        {
                            type: "text",
                            text: "Error: Both arguments must be numbers."
                        }
                    ]
                };
            }
            const result = a + b;
            return {
                content: [
                    {
                        type: "text",
                        text: `Result: ${a} + ${b} = ${result}`
                    }
                ]
            };
        }
        if (name === "say_hello") {
            const { name: greetName } = args;
            if (typeof greetName !== 'string') {
                return {
                    content: [
                        {
                            type: "text",
                            text: "Error: Name must be a string."
                        }
                    ]
                };
            }
            return {
                content: [
                    {
                        type: "text",
                        text: `Hello, ${greetName}! Nice to meet you!`
                    }
                ]
            };
        }
        throw new Error(`Tool not found: ${name}`);
    });
    return server;
}
app.all('/mcp/:sessionId?', async (c) => {
    let sessionId = c.req.param('sessionId');
    if (!sessionId) {
        sessionId = 'default-session';
    }
    if (!sessionId) {
        let sessionId = 'default-session';
    }
    const env = c.env;
    try {
        await getSessionData(sessionId, env);
    }
    catch {
        await updateSessionData(sessionId, env, { unlocked: false });
    }
    if (!servers[sessionId]) {
        servers[sessionId] = createMcpServer(sessionId, env);
    }
    const transport = new StreamableHTTPTransport();
    await servers[sessionId].connect(transport);
    return transport.handleRequest(c);
});
app.get('/', (c) => {
    return c.json({
        message: 'Server is running',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
    });
});
app.get('/session/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId');
    const env = c.env;
    try {
        const sessionData = await getSessionData(sessionId, env);
        return c.json({
            sessionId: sessionId.substring(0, 8) + '...',
            unlocked: sessionData.unlocked,
            availableTools: sessionData.unlocked
                ? [baseTool.name, ...unlockedTools.map(t => t.name)]
                : [baseTool.name]
        });
    }
    catch {
        return c.json({ error: 'Session not found' }, 404);
    }
});
app.post('/debug/unlock/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId');
    const env = c.env;
    try {
        await updateSessionData(sessionId, env, { unlocked: true });
        return c.json({
            message: `Session ${sessionId.substring(0, 8)}... unlocked`,
            unlocked: true,
            availableTools: [baseTool.name, ...unlockedTools.map(t => t.name)]
        });
    }
    catch {
        return c.json({ error: 'Session not found' }, 404);
    }
});
export default app;

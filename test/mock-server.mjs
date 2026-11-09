// A local HTTP server that records the exact bytes of each request head and
// answers with provider-shaped SSE, so tests can assert what actually reached
// the wire rather than what a configuration object contained.
import http from 'node:http'

/**
 * Start a recording mock server.
 * @param {{ responder?: (request: object, response: import('node:http').ServerResponse) => void }} [options]
 * @returns {Promise<{ url: string, requests: object[], setResponder: Function, close: Function, reset: Function }>}
 */
export async function startMockServer (options = {}) {
  const requests = []
  let responder = options.responder ?? sseResponder(openaiResponsesBody({ text: 'Hello' }))
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const rawHeaders = []
      for (let index = 0; index < req.rawHeaders.length; index += 2) {
        rawHeaders.push([req.rawHeaders[index], req.rawHeaders[index + 1]])
      }
      const record = {
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        rawHeaders,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      requests.push(record)
      try {
        responder(record, res)
      } catch (error) {
        res.statusCode = 500
        res.end(String(error))
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    setResponder: (next) => { responder = next },
    reset: () => { requests.length = 0 },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** Write SSE frames and end the response. */
export function sseResponder (frames) {
  return (request, res) => {
    if (typeof frames === 'function') frames = frames(request)
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    for (const frame of frames) res.write(frame)
    res.end()
  }
}

/** One SSE frame; an empty event name still sends `data:` only. */
export function frame (event, data) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data)
  return `${event === undefined ? '' : `event: ${event}\n`}data: ${payload}\n\n`
}

/** Every `user-agent` field as it appeared on the wire, spelling preserved. */
export function userAgentFields (request) {
  return request.rawHeaders.filter(([name]) => name.toLowerCase() === 'user-agent')
}

/** One header value as the server parsed it, or undefined. */
export function headerValue (request, name) {
  return request.headers[name.toLowerCase()]
}

/**
 * An OpenAI Responses SSE body.
 * @param {{ text?: string, toolCall?: { name: string, id: string, arguments: string }, usage?: object }} input
 * @returns {string[]} frames
 */
export function openaiResponsesBody ({ text, toolCall, usage } = {}) {
  const frames = [
    frame('response.created', { type: 'response.created', response: { id: 'resp_test_1', status: 'in_progress' } }),
  ]
  if (toolCall !== undefined) {
    frames.push(
      frame('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'fc_test_1', type: 'function_call', call_id: toolCall.id, name: toolCall.name, arguments: '', status: 'in_progress' },
      }),
      frame('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        item_id: 'fc_test_1',
        delta: toolCall.arguments,
      }),
      frame('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        output_index: 0,
        item_id: 'fc_test_1',
        arguments: toolCall.arguments,
      }),
      frame('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 0,
        item: { id: 'fc_test_1', type: 'function_call', call_id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments, status: 'completed' },
      }),
    )
  }
  if (text !== undefined) {
    frames.push(
      frame('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: toolCall === undefined ? 0 : 1,
        item: { id: 'msg_test_1', type: 'message', role: 'assistant', content: [], status: 'in_progress' },
      }),
      frame('response.output_text.delta', {
        type: 'response.output_text.delta',
        output_index: toolCall === undefined ? 0 : 1,
        item_id: 'msg_test_1',
        content_index: 0,
        delta: text,
      }),
      frame('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: toolCall === undefined ? 0 : 1,
        item: { id: 'msg_test_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] },
      }),
    )
  }
  frames.push(frame('response.completed', {
    type: 'response.completed',
    response: {
      id: 'resp_test_1',
      status: 'completed',
      output: [],
      ...(usage === undefined ? {} : { usage }),
    },
  }))
  return frames
}

/**
 * An OpenAI Chat Completions SSE body (the classic `chat.completion.chunk`
 * stream, terminated by `[DONE]`).
 * @param {{ text?: string, toolCall?: { name: string, id: string, arguments: string }, usage?: object }} input
 * @returns {string[]} frames
 */
export function openaiChatCompletionsBody ({ text, toolCall, usage } = {}) {
  const base = { id: 'chatcmpl_test_1', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-flash' }
  const frames = [
    frame(undefined, {
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    }),
  ]
  if (toolCall !== undefined) {
    frames.push(
      frame(undefined, {
        ...base,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: '' } }],
          },
          finish_reason: null,
        }],
      }),
      frame(undefined, {
        ...base,
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: toolCall.arguments } }] },
          finish_reason: null,
        }],
      }),
    )
  }
  if (text !== undefined) {
    frames.push(frame(undefined, {
      ...base,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    }))
  }
  frames.push(frame(undefined, {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: toolCall === undefined ? 'stop' : 'tool_calls' }],
    ...(usage === undefined ? {} : { usage }),
  }))
  frames.push('data: [DONE]\n\n')
  return frames
}

/**
 * An Anthropic Messages SSE body.
 * @param {{ text?: string, toolCall?: { name: string, id: string, arguments: string }, usage?: object }} input
 * @returns {string[]} frames
 */
export function anthropicMessagesBody ({ text, toolCall, usage } = {}) {
  const frames = [
    frame('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_test_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 7, output_tokens: 1, ...usage },
      },
    }),
  ]
  if (toolCall !== undefined) {
    frames.push(
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: toolCall.id, name: toolCall.name, input: {} },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: toolCall.arguments },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    )
  }
  if (text !== undefined) {
    const index = toolCall === undefined ? 0 : 1
    frames.push(
      frame('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }),
      frame('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }),
      frame('content_block_stop', { type: 'content_block_stop', index }),
    )
  }
  frames.push(
    frame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: toolCall === undefined ? 'end_turn' : 'tool_use', stop_sequence: null },
      usage: { output_tokens: 3 },
    }),
    frame('message_stop', { type: 'message_stop' }),
  )
  return frames
}

/** A JSON error response, for the error-propagation test. */
export function jsonErrorResponder (status, body) {
  return (_request, res) => {
    const payload = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    res.end(payload)
  }
}

/** A JSON success response, for the model-listing tests. */
export function jsonResponder (body, status = 200) {
  return (_request, res) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    res.end(payload)
  }
}

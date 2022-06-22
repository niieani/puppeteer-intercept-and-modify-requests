/* eslint-disable no-continue,no-await-in-loop,node/no-unpublished-import */
import { promisify } from 'util'
import type { CDPSession, Protocol } from 'puppeteer'
import { getUrlPatternRegExp } from './urlPattern'

export { getUrlPatternRegExp }

const STATUS_CODE_OK = 200

export type ModifiedResponse =
  | ((
      | {
          responseCode?: number
          responseHeaders?: Protocol.Fetch.HeaderEntry[]
          body?: string
        }
      | {
          errorReason: Protocol.Network.ErrorReason
        }
    ) & {
      delay?: number
    })
  | void

export type ModifiedRequest =
  | (ModifiedResponse &
      Omit<
        Protocol.Fetch.ContinueRequestRequest,
        'requestId' | 'interceptResponse'
      >)
  | void

export type Interception = Omit<Protocol.Fetch.RequestPattern, 'requestStage'> &
  Pick<Required<Protocol.Fetch.RequestPattern>, 'urlPattern'> & {
    modifyResponse?: (response: {
      body: string
      event: Protocol.Fetch.RequestPausedEvent
    }) => ModifiedResponse | Promise<ModifiedResponse>
    // if present, set requestStage to 'Request'; if both, set additionally 'interceptResponse' in 'continueRequest', unless body provided
    modifyRequest?: (request: {
      event: Protocol.Fetch.RequestPausedEvent
    }) => ModifiedRequest | Promise<ModifiedRequest>
  }

export type InterceptionWithUrlPatternRegExp = Interception & {
  urlPatternRegExp: RegExp
}

const wait = promisify(setTimeout)

export class RequestInterceptionManager {
  interceptions: Map<string, InterceptionWithUrlPatternRegExp> = new Map()
  #client: CDPSession
  constructor(client: CDPSession) {
    this.#client = client
    client.on(
      'Fetch.requestPaused',
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      this.onRequestPausedEvent,
    )
  }

  async intercept(...interceptions: Interception[]) {
    if (interceptions.length === 0) return
    interceptions.forEach((interception) => {
      this.interceptions.set(interception.urlPattern, {
        ...interception,
        urlPatternRegExp: getUrlPatternRegExp(interception.urlPattern),
      })
    })
    await this.enable()
  }

  async removeIntercept(interceptUrlPattern: string) {
    if (this.interceptions.delete(interceptUrlPattern)) {
      await (this.interceptions.size > 0 ? this.enable() : this.disable())
    }
  }

  async enable(): Promise<void> {
    return this.#client.send('Fetch.enable', {
      handleAuthRequests: false,
      patterns: [...this.interceptions.values()].map(
        ({ modifyRequest, modifyResponse, ...config }) =>
          ({
            ...config,
            requestStage: modifyRequest ? 'Request' : 'Response',
          } as const),
      ),
    })
  }

  async disable(): Promise<void> {
    return this.#client.send('Fetch.disable')
  }

  async clear() {
    this.interceptions.clear()
    await this.disable()
  }

  onRequestPausedEvent = async (event: Protocol.Fetch.RequestPausedEvent) => {
    const { requestId, responseStatusCode, request } = event
    for (const {
      modifyRequest,
      modifyResponse,
      resourceType,
      urlPattern,
      urlPatternRegExp,
    } of this.interceptions.values()) {
      if (resourceType && resourceType !== event.resourceType) continue
      if (urlPattern && !urlPatternRegExp.test(request.url)) continue

      if (!responseStatusCode) {
        // handling a request
        const { delay, ...modification } =
          (await modifyRequest?.({ event })) ?? {}
        if (delay) await wait(delay)

        if (Object.keys(modification).length === 0) {
          await this.#client.send('Fetch.continueRequest', {
            ...modification,
            requestId,
            interceptResponse: Boolean(modifyResponse),
          })
        } else if ('errorReason' in modification) {
          await this.#client.send('Fetch.failRequest', {
            requestId,
            errorReason: modification.errorReason,
          })
        } else {
          await this.#client.send('Fetch.fulfillRequest', {
            ...modification,
            requestId,
            body: modification.body
              ? Buffer.from(modification.body).toString('base64')
              : undefined,
            responseCode: modification.responseCode ?? STATUS_CODE_OK,
          })
        }
      } else if (modifyResponse) {
        // note: for streaming, use Fetch.takeResponseBodyAsStream
        const response = await this.#client.send('Fetch.getResponseBody', {
          requestId,
        })
        const { delay, ...modification } =
          (await modifyResponse({
            body: response.base64Encoded
              ? Buffer.from(response.body, 'base64').toString('utf8')
              : response.body,
            event,
          })) ?? {}

        if (delay) await wait(delay)

        if ('errorReason' in modification) {
          await this.#client.send('Fetch.failRequest', {
            requestId,
            errorReason: modification.errorReason,
          })
          return
        }

        await this.#client.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: responseStatusCode,
          responseHeaders: event.responseHeaders,
          ...modification,
          body: modification.body
            ? Buffer.from(modification.body).toString('base64')
            : undefined,
        })
      }
    }
  }
}

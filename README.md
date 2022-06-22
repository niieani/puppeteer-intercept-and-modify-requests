# puppeteer-intercept-and-modify-requests

To modify intercepted requests:

```ts
import { RequestInterceptionManager } from 'puppeteer-intercept-and-modify-requests'

// assuming 'page' is your Puppeteer page object
const client = await page.target().createCDPSession()
const interceptManager = new RequestInterceptionManager(client)

await interceptManager.intercept(
  {
    urlPattern: `https://example.com/*`,
    resourceType: 'Document',
    modifyResponse({ body }) {
      return {
        // replace break lines with horizontal lines:
        body: body.replaceAll('<br/>', '<hr/>'),
      }
    },
  },
  {
    urlPattern: '*/api/v4/user.json',
    modifyResponse({ body }) {
      const parsed = JSON.parse(body)
      // set role property to 'admin'
      parsed.role = 'admin'
      return {
        body: JSON.stringify(parsed),
      }
    },
  },
)
```

Other functionality:

- You may deny the request by returning an object with `errorReason` instead of a `body`.
- You may modify the request itself, before it is sent to the server, by adding a `modifyRequest` function.
- You may passthrough the request without any modification, by returning `undefined`.

See `Interception` type definition for other options and usage.

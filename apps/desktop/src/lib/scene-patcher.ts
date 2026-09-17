/**
 * Scene patcher — sends property changes to scene iframes via postMessage
 * for instant live preview without reloading.
 */

export function patchElementInIframe(
  iframe: HTMLIFrameElement | null,
  elementId: string,
  property: string,
  value: unknown,
) {
  iframe?.contentWindow?.postMessage(
    {
      target: 'dreambyte-scene',
      type: 'patch_element',
      elementId,
      property,
      value,
    },
    '*',
  )
}

export function highlightElementInIframe(iframe: HTMLIFrameElement | null, elementId: string | null) {
  iframe?.contentWindow?.postMessage(
    {
      target: 'dreambyte-scene',
      type: 'highlight_element',
      elementId,
    },
    '*',
  )
}

export function requestElementsFromIframe(iframe: HTMLIFrameElement | null) {
  iframe?.contentWindow?.postMessage(
    {
      target: 'dreambyte-scene',
      type: 'get_elements',
    },
    '*',
  )
}

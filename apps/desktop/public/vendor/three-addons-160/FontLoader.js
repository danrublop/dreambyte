/**
 * FontLoader + Font — vendored from three@0.160.0/examples/jsm/loaders/FontLoader.js.
 * Rewritten as a classic script that extends window.THREE.Loader (an ES6
 * class in r160), so it shares the UMD THREE instance and does not trip the
 * "Multiple instances of Three.js" warning. Exposes window.FontLoader and
 * window.Font.
 *
 * License: MIT (three.js). See https://github.com/mrdoob/three.js/blob/master/LICENSE
 */
;(function () {
  'use strict'
  var T = window.THREE
  if (!T) {
    console.error('[FontLoader] window.THREE not found — load three.min.js first.')
    return
  }

  class FontLoader extends T.Loader {
    constructor(manager) {
      super(manager)
    }
    load(url, onLoad, onProgress, onError) {
      const scope = this
      const loader = new T.FileLoader(this.manager)
      loader.setPath(this.path)
      loader.setRequestHeader(this.requestHeader)
      loader.setWithCredentials(this.withCredentials)
      loader.load(
        url,
        function (text) {
          const font = scope.parse(JSON.parse(text))
          if (onLoad) onLoad(font)
        },
        onProgress,
        onError,
      )
    }
    parse(json) {
      return new Font(json)
    }
  }

  class Font {
    constructor(data) {
      this.isFont = true
      this.type = 'Font'
      this.data = data
    }
    generateShapes(text, size) {
      if (size === undefined) size = 100
      const shapes = []
      const paths = createPaths(text, size, this.data)
      for (let p = 0; p < paths.length; p++) {
        Array.prototype.push.apply(shapes, paths[p].toShapes())
      }
      return shapes
    }
  }

  function createPaths(text, size, data) {
    const chars = Array.from(text)
    const scale = size / data.resolution
    const line_height = (data.boundingBox.yMax - data.boundingBox.yMin + data.underlineThickness) * scale
    const paths = []
    let offsetX = 0
    let offsetY = 0
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i]
      if (ch === '\n') {
        offsetX = 0
        offsetY -= line_height
      } else {
        const ret = createPath(ch, scale, offsetX, offsetY, data)
        if (ret) {
          offsetX += ret.offsetX
          paths.push(ret.path)
        }
      }
    }
    return paths
  }

  function createPath(ch, scale, offsetX, offsetY, data) {
    const glyph = data.glyphs[ch] || data.glyphs['?']
    if (!glyph) {
      console.error('THREE.Font: character "' + ch + '" does not exist in font family ' + data.familyName + '.')
      return
    }
    const path = new T.ShapePath()
    let x, y, cpx, cpy, cpx1, cpy1, cpx2, cpy2
    if (glyph.o) {
      const outline = glyph._cachedOutline || (glyph._cachedOutline = glyph.o.split(' '))
      for (let i = 0, l = outline.length; i < l; ) {
        const action = outline[i++]
        switch (action) {
          case 'm':
            x = outline[i++] * scale + offsetX
            y = outline[i++] * scale + offsetY
            path.moveTo(x, y)
            break
          case 'l':
            x = outline[i++] * scale + offsetX
            y = outline[i++] * scale + offsetY
            path.lineTo(x, y)
            break
          case 'q':
            cpx = outline[i++] * scale + offsetX
            cpy = outline[i++] * scale + offsetY
            cpx1 = outline[i++] * scale + offsetX
            cpy1 = outline[i++] * scale + offsetY
            path.quadraticCurveTo(cpx1, cpy1, cpx, cpy)
            break
          case 'b':
            cpx = outline[i++] * scale + offsetX
            cpy = outline[i++] * scale + offsetY
            cpx1 = outline[i++] * scale + offsetX
            cpy1 = outline[i++] * scale + offsetY
            cpx2 = outline[i++] * scale + offsetX
            cpy2 = outline[i++] * scale + offsetY
            path.bezierCurveTo(cpx1, cpy1, cpx2, cpy2, cpx, cpy)
            break
        }
      }
    }
    return { offsetX: glyph.ha * scale, path: path }
  }

  window.FontLoader = FontLoader
  window.Font = Font
})()

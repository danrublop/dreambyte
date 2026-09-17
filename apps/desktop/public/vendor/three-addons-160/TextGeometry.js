/**
 * TextGeometry — vendored from three@0.160.0/examples/jsm/geometries/TextGeometry.js.
 * Classic-script form that extends window.THREE.ExtrudeGeometry (an ES6 class
 * in r160) so it shares the UMD THREE instance. Exposes window.TextGeometry.
 *
 * License: MIT (three.js). See https://github.com/mrdoob/three.js/blob/master/LICENSE
 */
;(function () {
  'use strict'
  var T = window.THREE
  if (!T) {
    console.error('[TextGeometry] window.THREE not found — load three.min.js first.')
    return
  }

  class TextGeometry extends T.ExtrudeGeometry {
    constructor(text, parameters) {
      parameters = parameters || {}
      const font = parameters.font
      if (font === undefined) {
        super()
      } else {
        const shapes = font.generateShapes(text, parameters.size)
        parameters.depth =
          parameters.height !== undefined ? parameters.height : parameters.depth !== undefined ? parameters.depth : 50
        if (parameters.bevelThickness === undefined) parameters.bevelThickness = 10
        if (parameters.bevelSize === undefined) parameters.bevelSize = 8
        if (parameters.bevelEnabled === undefined) parameters.bevelEnabled = false
        super(shapes, parameters)
      }
      this.type = 'TextGeometry'
    }
  }

  window.TextGeometry = TextGeometry
})()

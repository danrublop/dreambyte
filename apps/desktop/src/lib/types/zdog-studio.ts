export type ZdogStudioShapeType =
  | 'Ellipse'
  | 'Rect'
  | 'RoundedRect'
  | 'Polygon'
  | 'Shape'
  | 'Anchor'
  | 'Group'
  | 'Box'
  | 'Cylinder'
  | 'Cone'
  | 'Hemisphere'

export interface ZdogVector {
  x?: number
  y?: number
  z?: number
}

export interface ZdogStudioShape {
  id: string
  type: ZdogStudioShapeType
  parentId?: string
  name: string
  properties: {
    stroke?: number
    color?: string
    fill?: boolean
    backface?: string | boolean
    frontFace?: string | boolean
    rearFace?: string | boolean
    leftFace?: string | boolean
    rightFace?: string | boolean
    topFace?: string | boolean
    bottomFace?: string | boolean
    diameter?: number
    width?: number
    height?: number
    depth?: number
    length?: number
    cornerRadius?: number
    sides?: number
    radius?: number
    quarters?: number
    closed?: boolean
    visible?: boolean
    path?: ZdogVector[]
  }
  transforms: {
    translate: ZdogVector
    rotate: ZdogVector
    scale: ZdogVector | number
  }
}

export interface ZdogStudioSceneState {
  shapes: ZdogStudioShape[]
  selectedId: string | null
  zoom: number
}

export interface ZdogStudioAsset {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  shapes: ZdogStudioShape[]
  tags?: string[]
}

'use client'

import { useState, useEffect } from 'react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useVideoStore } from '@/lib/store'
import SceneCard from './SceneCard'

interface Props {
  isCollapsed: boolean
  onToggleCollapse: () => void
}

function SortableSceneCard({ id, index }: { id: string; index: number }) {
  const { scenes, selectedSceneId } = useVideoStore()
  const scene = scenes.find((s) => s.id === id)!
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <SceneCard scene={scene} index={index} isSelected={selectedSceneId === id} isDragging={isDragging} />
    </div>
  )
}

export default function SceneList({ isCollapsed, onToggleCollapse }: Props) {
  const { scenes, reorderScenes } = useVideoStore()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [isFullyExpanded, setIsFullyExpanded] = useState(!isCollapsed)

  // Sync isFullyExpanded with isCollapsed with a delay for clean expansion
  useEffect(() => {
    if (isCollapsed) {
      setIsFullyExpanded(false)
    } else {
      const timer = setTimeout(() => setIsFullyExpanded(true), 200)
      return () => clearTimeout(timer)
    }
  }, [isCollapsed])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id))
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    setActiveId(null)
    if (!over || active.id === over.id) return
    const fromIndex = scenes.findIndex((s) => s.id === active.id)
    const toIndex = scenes.findIndex((s) => s.id === over.id)
    reorderScenes(fromIndex, toIndex)
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Scenes - only show when fully expanded to avoid 'scaling-up' flicker during animation */}
      <div className={`flex-1 overflow-y-auto pt-1 ${isFullyExpanded ? 'block' : 'hidden'}`}>
        {scenes.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-[#3a3a45] text-[11px] text-center px-4 uppercase font-bold tracking-widest">
            No scenes yet.
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={scenes.map((s) => s.id)} strategy={verticalListSortingStrategy}>
              {scenes.map((scene, index) => (
                <SortableSceneCard key={scene.id} id={scene.id} index={index} />
              ))}
            </SortableContext>
          </DndContext>
        )}
      </div>
    </div>
  )
}

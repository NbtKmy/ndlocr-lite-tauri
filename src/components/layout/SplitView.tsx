import { useRef, useState, useCallback, useEffect } from 'react'

interface SplitViewProps {
  left: React.ReactNode
  right: React.ReactNode
  defaultRatio?: number // 0–1, default 0.5
  minLeftPx?: number
  minRightPx?: number
}

export function SplitView({
  left,
  right,
  defaultRatio = 0.5,
  minLeftPx = 200,
  minRightPx = 200,
}: SplitViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [ratio, setRatio] = useState(defaultRatio)
  const dragging = useRef(false)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const totalWidth = rect.width
      const x = e.clientX - rect.left
      const minLeft = minLeftPx / totalWidth
      const minRight = minRightPx / totalWidth
      const newRatio = Math.max(minLeft, Math.min(1 - minRight, x / totalWidth))
      setRatio(newRatio)
    }

    const handleMouseUp = () => {
      if (!dragging.current) return
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [minLeftPx, minRightPx])

  return (
    <div className="split-view" ref={containerRef}>
      <div className="split-pane split-pane-left" style={{ flex: `0 0 calc(${ratio * 100}% - 4px)` }}>
        {left}
      </div>
      <div className="split-divider" onMouseDown={handleMouseDown} />
      <div className="split-pane split-pane-right" style={{ flex: `0 0 calc(${(1 - ratio) * 100}% - 4px)` }}>
        {right}
      </div>
    </div>
  )
}

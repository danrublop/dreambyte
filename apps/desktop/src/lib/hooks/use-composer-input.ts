'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useVideoStore } from '@/lib/store'
import { getCommandDefinitions } from '@/lib/agents/commands'
import { TOOL_FILTER_CHIPS } from '@/lib/agent-tools'
import { getMentionQuery, collectMentionTargets, filterTargetsForMention } from '@/lib/scene-mentions'
import {
  getSpeechRecognitionCtor,
  type BrowserSpeechRecognition,
  type BrowserSpeechResultEvent,
} from '@/lib/speech-recognition'

// Capability keyword guard map: a typed prompt mentioning a disabled capability
// surfaces the "enable" banner instead of silently sending. Moved here with the
// composer input; used only by checkKeywordGuard.
const CAPABILITY_KEYWORDS: Record<string, string[]> = {
  avatars: ['heygen', 'avatar', 'talking head'],
  'ai-video': ['veo3', 'veo', 'ai video', 'generate video'],
  three: ['3d', 'three.js', 'threejs', '3d scene', '3d object'],
  d3: ['d3 chart', 'bar chart', 'line chart', 'pie chart', 'scatter plot', 'data visualization'],
  'ai-images': ['generate image', 'ai image', 'flux', 'dall-e', 'ideogram', 'recraft'],
  lottie: ['lottie', 'lottie animation'],
  zdog: ['zdog', 'pseudo-3d', 'pseudo 3d', 'isometric illustration'],
  interactions: ['hotspot', 'quiz', 'branching', 'interactive'],
}

/**
 * Composer input core: owns the textarea input, slash-command
 * autocomplete, the voice-dictation subsystem (recognition + lang menu), the
 * keyword guard, the drag state, and the model/agent menu-open flags. Extracted
 * verbatim from AgentChat. Called IN AgentChat so handleSend / handleAbort /
 * handleNewChat / the home-composer drain effect / the JSX keep reading these
 * via destructure (no prop threading). `isGenerating` is passed in (gates voice);
 * `activeTools` is read from the store (keyword guard).
 */
export function useComposerInput({ isGenerating, generateMode }: { isGenerating: boolean; generateMode: boolean }) {
  const activeTools = useVideoStore((s) => s.activeTools)
  const scenes = useVideoStore((s) => s.scenes)

  const [input, setInput] = useState('')
  const [slashIdx, setSlashIdx] = useState(0)
  const [mentionIdx, setMentionIdx] = useState(0)
  const [showModelMenu, setShowModelMenu] = useState(false)
  const [showAgentMenu, setShowAgentMenu] = useState(false)
  const [keywordWarning, setKeywordWarning] = useState<{ capability: string; label: string } | null>(null)
  const [isDraggingImage, setIsDraggingImage] = useState(false)
  const speechRecognitionRef = useRef<BrowserSpeechRecognition | null>(null)
  const speechBaseRef = useRef('')
  const speechFinalRef = useRef('')
  const [isListening, setIsListening] = useState(false)
  const [speechSupported, setSpeechSupported] = useState(false)
  const [showSpeechLangMenu, setShowSpeechLangMenu] = useState(false)
  const [speechLang, setSpeechLang] = useState('en-US')

  useEffect(() => {
    setSpeechSupported(!!getSpeechRecognitionCtor())
  }, [])

  useEffect(() => {
    try {
      const s = localStorage.getItem('dreambyte-agent-speech-lang')
      if (s) {
        setSpeechLang(s)
        return
      }
    } catch {}
    if (typeof navigator !== 'undefined' && navigator.language) {
      setSpeechLang(navigator.language)
    }
  }, [])

  useEffect(() => {
    return () => {
      try {
        speechRecognitionRef.current?.abort()
      } catch {}
      speechRecognitionRef.current = null
    }
  }, [])

  const checkKeywordGuard = useCallback(
    (text: string): { capability: string; label: string } | null => {
      const lower = text.toLowerCase()
      for (const [capId, keywords] of Object.entries(CAPABILITY_KEYWORDS)) {
        if (!activeTools.includes(capId)) {
          for (const kw of keywords) {
            if (lower.includes(kw)) {
              const chip = TOOL_FILTER_CHIPS.find((c) => c.id === capId)
              return { capability: capId, label: chip?.label ?? capId }
            }
          }
        }
      }
      return null
    },
    [activeTools],
  )

  const stopVoiceInput = useCallback(() => {
    try {
      speechRecognitionRef.current?.stop()
    } catch {}
    speechRecognitionRef.current = null
    setIsListening(false)
    setShowSpeechLangMenu(false)
  }, [])

  const startVoiceInput = useCallback(
    (langOverride?: string) => {
      const Ctor = getSpeechRecognitionCtor()
      if (!Ctor || isGenerating) return

      const lang = langOverride ?? speechLang

      setShowModelMenu(false)
      setShowAgentMenu(false)
      setShowSpeechLangMenu(false)

      try {
        speechRecognitionRef.current?.abort()
      } catch {}
      speechRecognitionRef.current = null

      const rec = new Ctor()
      speechRecognitionRef.current = rec
      rec.continuous = true
      rec.interimResults = true
      rec.lang = lang

      speechBaseRef.current = input.trim() ? `${input.trim()} ` : ''
      speechFinalRef.current = ''

      rec.onresult = (event: BrowserSpeechResultEvent) => {
        let interim = ''
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const piece = event.results[i][0].transcript
          if (event.results[i].isFinal) {
            speechFinalRef.current += piece
          } else {
            interim += piece
          }
        }
        setInput(speechBaseRef.current + speechFinalRef.current + interim)
      }

      rec.onerror = (ev: { error: string }) => {
        if (ev.error !== 'aborted' && ev.error !== 'no-speech') {
          console.warn('[AgentChat] Speech recognition:', ev.error)
        }
        setIsListening(false)
        speechRecognitionRef.current = null
      }

      rec.onend = () => {
        setIsListening(false)
        speechRecognitionRef.current = null
      }

      try {
        rec.start()
        setIsListening(true)
      } catch (e) {
        console.warn('[AgentChat] Speech recognition start failed:', e)
        setIsListening(false)
        speechRecognitionRef.current = null
      }
    },
    [input, isGenerating, speechLang],
  )

  const toggleVoiceInput = useCallback(() => {
    if (isListening) {
      stopVoiceInput()
      return
    }
    startVoiceInput()
  }, [isListening, stopVoiceInput, startVoiceInput])

  const handleSelectSpeechLang = useCallback(
    (code: string) => {
      setSpeechLang(code)
      try {
        localStorage.setItem('dreambyte-agent-speech-lang', code)
      } catch {}
      setShowSpeechLangMenu(false)
      if (isListening) {
        stopVoiceInput()
        window.setTimeout(() => startVoiceInput(code), 100)
      }
    },
    [isListening, stopVoiceInput, startVoiceInput],
  )

  // ── Derived state ──────────────────────────────────────────────────────────────

  // Slash command autocomplete — only show while the user is typing the command
  // name (no space yet). Once they start typing args, suggestions disappear.
  const slashSuggestions = (() => {
    const t = input
    if (!t.startsWith('/') || t.includes(' ')) return [] as ReturnType<typeof getCommandDefinitions>
    const q = t.slice(1).toLowerCase()
    return getCommandDefinitions().filter((c) => c.name.startsWith(q))
  })()
  // Clamp the highlighted index when the suggestion list shrinks (e.g. user
  // narrowed the prefix from "/p" to "/pl"). Without this the dropdown can
  // momentarily render no highlight or aim past the end of the list.
  useEffect(() => {
    if (slashIdx >= slashSuggestions.length) setSlashIdx(0)
  }, [slashSuggestions.length, slashIdx])

  // Scene @-mention autocomplete (scenes only). Tail-anchored: the
  // active mention is the '@token' being typed at the end of the input —
  // the same simplification the slash menu makes by matching input start.
  const mentionQuery = generateMode ? null : getMentionQuery(input)
  const mentionSuggestions =
    mentionQuery !== null ? filterTargetsForMention(collectMentionTargets(scenes), mentionQuery) : []
  useEffect(() => {
    if (mentionIdx >= mentionSuggestions.length) setMentionIdx(0)
  }, [mentionSuggestions.length, mentionIdx])

  return {
    input,
    setInput,
    slashIdx,
    setSlashIdx,
    slashSuggestions,
    mentionIdx,
    setMentionIdx,
    mentionSuggestions,
    showModelMenu,
    setShowModelMenu,
    showAgentMenu,
    setShowAgentMenu,
    keywordWarning,
    setKeywordWarning,
    checkKeywordGuard,
    isDraggingImage,
    setIsDraggingImage,
    speechRecognitionRef,
    isListening,
    setIsListening,
    speechSupported,
    speechLang,
    showSpeechLangMenu,
    setShowSpeechLangMenu,
    startVoiceInput,
    stopVoiceInput,
    toggleVoiceInput,
    handleSelectSpeechLang,
  }
}

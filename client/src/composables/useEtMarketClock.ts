import { onMounted, onUnmounted, ref } from 'vue'

const TZ = 'America/New_York'

/** US regular session Mon–Fri 09:30–16:00 ET (no holiday calendar). */
const formatEtClock = (now: Date) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    month: 'short',
    day: 'numeric',
    hourCycle: 'h23'
  }).formatToParts(now)

  const get = (t: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === t)?.value ?? ''

  const wd = get('weekday')
  const hour = parseInt(get('hour'), 10)
  const minute = parseInt(get('minute'), 10)
  const mins = hour * 60 + minute

  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  const date = `${get('month')} ${get('day')}`

  let session = '休市'
  if (wd === 'Saturday' || wd === 'Sunday') {
    session = '休市'
  } else if (mins < 9 * 60 + 30) {
    session = '盘前'
  } else if (mins >= 16 * 60) {
    session = '盘后'
  } else {
    session = '开盘中'
  }

  return { time, date, session }
}

/**
 * Live NYC clock + coarse equity session label (weekday RTH only; holidays not modeled).
 * Ticks every second so the display tracks wall clock.
 */
export const useEtMarketClock = () => {
  const time = ref('')
  const date = ref('')
  const session = ref('')

  const tick = () => {
    const o = formatEtClock(new Date())
    time.value = o.time
    date.value = o.date
    session.value = o.session
  }

  let id: ReturnType<typeof setInterval> | undefined

  onMounted(() => {
    tick()
    id = setInterval(tick, 1000)
  })

  onUnmounted(() => {
    if (id != null) clearInterval(id)
  })

  return { time, date, session }
}

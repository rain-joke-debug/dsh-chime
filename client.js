/**
 * dsh-chime — browser half.
 *
 * Renders the volume control on this bundle's own page in the Plugins panel:
 * the Plugins list → dsh-chime → between the description and the rows. That is
 * the seat `plugins.bundle.config` exists for, keyed by the package name.
 *
 * The slider is the whole interface. Reading and writing go through one tiny
 * route the host half serves, because a page cannot touch `volume.txt` itself.
 *
 * Plain JavaScript on purpose: the module table hands us React, and a plugin
 * must not import any Harness Client package. Styling is limited to the
 * `--dsw-alias-*` theme tokens, each with a fallback, so a renamed token can
 * only cost appearance and never break the control.
 *
 * @module dsh-chime/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-chime',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** The host half's route. Same origin, so a bare path is enough. */
    const ROUTE = '/dsh-chime/volume'
    const MIN = 0
    const MAX = 200
    const LOUD = 130

    /** Theme tokens with fallbacks; see the module note. */
    const T = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      dim: 'var(--dsw-alias-label-secondary, #8a8a8a)',
      layer: 'var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.10))',
      border: 'var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.30))',
      brand: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      warn: 'var(--dsw-alias-state-warn-primary, #d97706)',
      error: 'var(--dsw-alias-state-error-primary, #dc2626)',
    }

    /** One request to the host half; rejects with a readable message. */
    function call(method, payload) {
      const init = { method, headers: { accept: 'application/json' } }
      if (payload !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(payload)
      }
      return fetch(ROUTE, init).then((response) =>
        response
          .json()
          .catch(() => ({}))
          .then((data) => {
            if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
            return data
          }),
      )
    }

    function reasonOf(error) {
      return String((error && error.message) || error || 'unknown error')
    }

    /**
     * The volume row. Resting the slider saves and plays one preview, so the
     * number on screen is always a number you have already heard.
     */
    function VolumeRow(props) {
      const view = props && props.view
      const [saved, setSaved] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [note, setNote] = React.useState('正在读取…')
      const [bad, setBad] = React.useState(false)
      const settle = React.useRef(null)

      React.useEffect(() => {
        let alive = true
        call('GET').then(
          (data) => {
            if (!alive) return
            setSaved(data.volume)
            setNote(data.file ? '已保存到 volume.txt' : '当前用配置里的默认值')
          },
          (error) => {
            if (!alive) return
            setBad(true)
            setNote('读不到音量：' + reasonOf(error))
          },
        )
        return () => {
          alive = false
          if (settle.current) clearTimeout(settle.current)
        }
      }, [])

      const volume = draft === null ? (saved === null ? 100 : saved) : draft

      function commit(value) {
        call('POST', { volume: value, preview: true }).then(
          (data) => {
            setSaved(data.volume)
            setBad(false)
            setNote('已保存，下一声立刻用 ' + data.volume + '%')
          },
          (error) => {
            setBad(true)
            setNote('没保存成功：' + reasonOf(error))
          },
        )
      }

      function onSlide(event) {
        const value = Number(event.target.value)
        setDraft(value)
        // "Stop moving, hear it": one save plus one preview per rest.
        if (settle.current) clearTimeout(settle.current)
        settle.current = setTimeout(() => {
          setDraft(null)
          commit(value)
        }, 450)
      }

      const summary = `${volume}%`
      if (view === 'summary') return h('span', { style: { color: T.dim } }, '音量 ' + summary)

      const loud = volume > LOUD
      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            padding: '12px 14px',
            margin: '0 0 12px',
            border: `1px solid ${T.border}`,
            borderRadius: '8px',
            background: T.layer,
            color: T.text,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: '8px' } },
          h('span', { style: { fontWeight: 600 } }, '提醒音音量'),
          h(
            'span',
            {
              style: {
                marginLeft: 'auto',
                fontVariantNumeric: 'tabular-nums',
                fontWeight: 600,
                color: bad ? T.error : loud ? T.warn : T.text,
              },
            },
            summary,
          ),
        ),
        h('input', {
          type: 'range',
          min: MIN,
          max: MAX,
          step: 5,
          value: volume,
          'aria-label': '提醒音音量',
          onChange: onSlide,
          style: { width: '100%', accentColor: T.brand, cursor: 'pointer' },
        }),
        h('div', { style: { color: bad ? T.error : T.dim, fontSize: '12px' } }, note),
        h(
          'div',
          { style: { color: T.dim, fontSize: '12px' } },
          loud
            ? `超过 ${LOUD}% 时最大声的地方会削顶（破音）`
            : '松手即保存，并立刻用新音量响一次。100% 是调好的标准音量。',
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // inject() waits for the declaration, so this works no matter which
        // side of the Plugins panel activates first, and it is withdrawn when
        // that page is not there.
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            { name: 'plugins.bundle.config', key: 'dsh-chime' },
            VolumeRow,
          ),
        )
      },
    }
  },
})

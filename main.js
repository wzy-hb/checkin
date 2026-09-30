const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0'

const request = async (url, options) => {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(20000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  let data
  try {
    data = await response.json()
  } catch {
    throw new Error('GLaDOS returned a non-JSON response')
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('GLaDOS returned an invalid response')
  }
  return data
}

const glados = async () => {
  const notice = []
  const cookies = String(process.env.GLADOS || '').split('\n').filter((cookie) => cookie.trim())
  if (!cookies.length) {
    process.exitCode = 1
    return ['Checkin Error', 'GLADOS cookie is missing']
  }
  const userAgent = process.env.GLADOS_USER_AGENT || DEFAULT_USER_AGENT
  const browserHints = userAgent === DEFAULT_USER_AGENT ? {
    'sec-ch-ua': '"Chromium";v="154", "Microsoft Edge";v="154", "Not A(Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
  } : {}
  for (const cookie of cookies) {
    try {
      const common = {
        'cookie': cookie,
        'referer': 'https://glados.cloud/console/checkin',
        'origin': 'https://glados.cloud',
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'user-agent': userAgent,
        ...browserHints,
      }
      const action = await request('https://glados.cloud/api/user/checkin', {
        method: 'POST',
        headers: { ...common, 'content-type': 'application/json' },
        body: '{"token":"glados.cloud"}',
      })
      const message = String(action.message ?? '')
      const normalized = message.trim().toLowerCase()
      const alreadyDone = normalized.startsWith('checkin repeats! please try tomorrow')
      const observation = normalized.startsWith("today's observation logged")
      const authDenied = action.reason === 'device-mismatch' ||
        /automated check-in detected|没有权限|unauthorized|permission/i.test(message)
      const accepted = action.code === 0 || (action.code === 1 && (alreadyDone || observation))
      if (authDenied || !accepted) {
        const deviceInfo = action.reason === 'device-mismatch' ?
          ['loginDevice', 'currentDevice']
            .filter((key) => typeof action[key] === 'string')
            .map((key) => `${key}=${action[key].slice(0, 200).replace(/[\r\n]/g, ' ')}`)
            .join(', ') : ''
        throw new Error(`${message || 'Checkin failed'} (code=${action.code ?? 'missing'}, reason=${action.reason ?? 'unspecified'}${deviceInfo ? ', ' + deviceInfo : ''})`)
      }
      const status = await request('https://glados.cloud/api/user/status', {
        method: 'GET',
        headers: { ...common },
      })
      if (status.code !== 0) {
        throw new Error(String(status.message || `Status returned code=${status.code ?? 'missing'}`))
      }
      const leftDays = status.data?.leftDays
      if (leftDays == null || String(leftDays).trim() === '' ||
          !['number', 'string'].includes(typeof leftDays) || !Number.isFinite(Number(leftDays))) {
        throw new Error('Status returned invalid leftDays')
      }
      notice.push(
        alreadyDone ? 'Checkin Already Done' : 'Checkin OK',
        message,
        `Left Days ${Number(leftDays)}`
      )
    } catch (error) {
      process.exitCode = 1
      notice.push(
        'Checkin Error',
        `${error}`,
        `<${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}>`
      )
    }
  }
  return notice
}

const notify = async (notice) => {
  if (!process.env.NOTIFY || !notice) return
  for (const option of String(process.env.NOTIFY).split('\n')) {
    if (!option) continue
    try {
      if (option.startsWith('console:')) {
        for (const line of notice) {
          console.log(line)
        }
      } else if (option.startsWith('wxpusher:')) {
        await fetch(`https://wxpusher.zjiecode.com/api/send/message`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            appToken: option.split(':')[1],
            summary: notice[0],
            content: notice.join('<br>'),
            contentType: 3,
            uids: option.split(':').slice(2),
          }),
        })
      } else if (option.startsWith('pushplus:')) {
        await fetch(`https://www.pushplus.plus/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: option.split(':')[1],
            title: notice[0],
            content: notice.join('<br>'),
            template: 'markdown',
          }),
        })
      } else if (option.startsWith('bark:')) {
        await fetch(`https://api.day.app/${option.split(':')[1]}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: notice[0],
            body: notice.slice(1).join('\n'),
          }),
        })
      } else if (option.startsWith('qyweixin:')) {
        const qyweixinToken = option.split(':')[1]
        const qyweixinNotifyRebotUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=' + qyweixinToken;
        await fetch(qyweixinNotifyRebotUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            msgtype: 'markdown',
            markdown: {
                content: notice.join('<br>')
            }
          }),
        })
      } else {
        // fallback
        await fetch(`https://www.pushplus.plus/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: option,
            title: notice[0],
            content: notice.join('<br>'),
            template: 'markdown',
          }),
        })
      }
    } catch (error) {
      throw error
    }
  }
}

const main = async () => {
  await notify(await glados())
}

main().catch((error) => {
  process.exitCode = 1
  console.error(`Checkin Error: ${error.message}`)
})

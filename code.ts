import {
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeWASocket,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys'
import type { proto, WASocket } from '@whiskeysockets/baileys'
import { downloadMediaMessage } from '@whiskeysockets/baileys'
import type { AnyMessageContent } from '@whiskeysockets/baileys'
import pino from 'pino'
import readline from 'readline'

let phoneJid = ''
let phoneNumber = ''
let pairingCodeRequested = false // Prevent multiple pairing code requests

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

rl.question(
  'ESPAÑOL: Ingresa tu número de WhatsApp (sin +)\nIntroduce your whatsapp phone number: ',
  (num) => {
    const phoneRegex = /^[0-9]{8,15}$/
    if (!phoneRegex.test(num)) {
      console.log('Número inválido. Debe contener solo dígitos y tener entre 8 y 15 caracteres.')
      rl.close()
      return
    }
    phoneNumber = num
    phoneJid = `${num}@s.whatsapp.net`
    console.log('Tu JID es:', phoneJid)
    rl.close()
    startBot().catch(console.error)
  }
)

type MediaMessage =
  | { text: string }
  | { image: any; caption?: string }
  | { video: any; caption?: string }

const logger = pino({ level: 'silent' })

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  const { version } = await fetchLatestBaileysVersion()
  
  const sock = makeWASocket({
    version,
    logger,
    auth: state,
    printQRInTerminal: false,
    markOnlineOnConnect: true,
    mobile: false,
  }) as WASocket & {
    sendMesg: (m: proto.IWebMessageInfo, content: string | MediaMessage) => Promise<any>
  }

  sock.sendMesg = async function (m, content) {
    const jid = m.key.remoteJid!
    const message = typeof content === 'string' ? { text: content } : content
    return sock.sendMessage(jid, message as AnyMessageContent)
  }

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update

    // Wait a bit after connecting state to ensure socket is ready
    if (connection === 'connecting' && !state.creds.registered && !pairingCodeRequested) {
      pairingCodeRequested = true
      console.log('🔄 Preparando conexión...')
      
      // Wait 2 seconds for socket to be ready
      setTimeout(async () => {
        console.log('📱 Solicitando código de emparejamiento...')
        try {
          const code = await sock.requestPairingCode(phoneNumber)
          console.log('🔑 Tu código de emparejamiento es:', code)
          console.log('💡 Ve a WhatsApp > Dispositivos vinculados > Vincular dispositivo > Vincular con número de teléfono')
          console.log('📝 Ingresa este código:', code)
          console.log('⏰ Tienes 60 segundos para ingresar el código...')
          
          // Wait 60 seconds for pairing
          setTimeout(() => {
            if (!state.creds.registered) {
              console.log('⏰ Tiempo agotado. El código ha expirado.')
              console.log('🔄 Reinicia el bot para obtener un nuevo código.')
              process.exit(1)
            }
          }, 60000)
          
        } catch (error) {
          console.error('❌ Error al solicitar código de emparejamiento:', error)
          pairingCodeRequested = false // Reset flag to allow retry
        }
      }, 2000)
    }

    if (connection === 'close') {
      const err = lastDisconnect?.error
      const shouldReconnect = (err as any)?.output?.statusCode !== DisconnectReason.loggedOut
      
      // Don't reconnect if we're waiting for pairing code
      if (pairingCodeRequested && !state.creds.registered) {
        console.log('⏳ Esperando que ingreses el código de emparejamiento...')
        return
      }
      
      console.log('Disconnected. Reconnecting?', shouldReconnect)
      if (shouldReconnect) {
        setTimeout(() => startBot(), 5000)
      }
    } else if (connection === 'open') {
      console.log('✅ Connected to WhatsApp')
      if (pairingCodeRequested) {
        console.log('🎉 ¡Emparejamiento exitoso! Bot conectado correctamente.')
        pairingCodeRequested = false
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      if (!m.message) continue
      const fromMe = m.key.fromMe
      const quotedContext = m.message.extendedTextMessage?.contextInfo
      const quoted = quotedContext?.quotedMessage

      if (fromMe && quoted?.imageMessage) {
        try {
          const downloadKey = quotedContext?.stanzaId ? { ...m.key, id: quotedContext.stanzaId } : m.key
          const buffer: Buffer = await downloadMediaMessage(
            { message: quoted, key: downloadKey },
            'buffer',
            {},
            { logger, reuploadRequest: sock.updateMediaMessage }
          )

          if (!sock.user?.id || !phoneJid) return

          setTimeout(async () => {
            try {
              await sock.sendMessage(phoneJid, { image: buffer })
              console.log('✅ Imagen enviada a tu número (con delay)')
            } catch (e) {
              console.error('❌ Error enviando imagen a tu número:', e)
            }
          }, 1000)
        } catch (err) {
          console.error('❌ Error descargando imagen:', err)
        }
      }
    }
  })

  return sock
}
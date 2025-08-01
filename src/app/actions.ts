'use server'

import InfluxWriter from '@/server/influxdb'
import { Nut } from '@/server/nut'
import { YamlSettings, SettingsType } from '@/server/settings'
import { DEVICE, server, DeviceData, DevicesData, VarDescription } from '@/common/types'
import chokidar from 'chokidar'
import { AuthError } from 'next-auth'
import { signIn, signOut } from '@/auth'
import { upsStatus } from '@/common/constants'

const settingsFile = './config/settings.yml'
// Cache settings instance
let settingsInstance: YamlSettings | null = null

// Initialize watcher
const watcher = chokidar.watch(settingsFile, {
  persistent: true,
  ignoreInitial: true,
})

// Reset settings instance when file changes
watcher.on('change', () => {
  settingsInstance = null
})

function getCachedSettings(): YamlSettings {
  settingsInstance ??= new YamlSettings(settingsFile)
  return settingsInstance
}

function connect(): Array<Nut> {
  try {
    const settings = getCachedSettings()
    const servers = settings.get('NUT_SERVERS')
    if (!Array.isArray(servers) || servers.length === 0) {
      return []
    }
    return servers.map((server: server) => new Nut(server.HOST, server.PORT, server.USERNAME, server.PASSWORD))
  } catch (e: any) {
    throw new Error(`Failed to connect to NUT servers: ${e.message}`)
  }
}

export async function testConnection(
  server: string,
  port: number,
  username?: string,
  password?: string
): Promise<string> {
  try {
    const nut = new Nut(server, port, username, password)
    const connection = await nut.testConnection()
    if (connection && username && password) {
      await nut.checkCredentials()
    }
    return connection
  } catch (error: any) {
    return Promise.reject(new Error(error.message))
  }
}

export async function authenticate(prevState: string | undefined, formData: FormData) {
  try {
    await signIn('credentials', formData)
  } catch (error) {
    if (error instanceof AuthError) {
      if (error.message === 'CredentialsSignin') {
        return 'Invalid credentials.'
      }
      return 'Something went wrong.'
    }
    throw error
  }
}

export async function logout() {
  await signOut()
}

export async function testInfluxConnection(host: string, token: string, org: string, bucket: string) {
  const influxdata = new InfluxWriter(host, token, org, bucket)
  return await influxdata.testConnection()
}

export async function getDevices(): Promise<DevicesData> {
  const nuts = connect()
  const deviceMap = new Map<string, DEVICE>()
  const deviceOrder: string[] = []
  const failedServers: string[] = []

  await Promise.all(
    nuts.map(async (nut) => {
      try {
        // Test connection first
        await nut.testConnection()

        const devices = await nut.getDevices()
        devices.forEach((device) => {
          if (!deviceOrder.includes(device.name)) {
            deviceOrder.push(device.name)
          }
        })

        await Promise.all(
          devices.map(async (device) => {
            // Skip if we already have this device
            if (deviceMap.has(device.name)) return

            const data = await nut.getData(device.name)
            const isReachable = data['ups.status']?.value !== upsStatus.DEVICE_UNREACHABLE

            const [rwVars, commands] = await Promise.all([
              isReachable ? nut.getRWVars(device.name) : Promise.resolve([]),
              isReachable ? nut.getCommands(device.name) : Promise.resolve([]),
            ])

            deviceMap.set(device.name, {
              vars: data,
              rwVars,
              description: device.description === 'Description unavailable' ? '' : device.description,
              clients: [],
              commands: nut.hasCredentials() ? commands : [],
              name: device.name,
            })
          })
        )
      } catch {
        // Add failed server to list
        failedServers.push(`${nut.getHost()}:${nut.getPort()}`)
      }
    })
  )

  return {
    devices: deviceOrder.map((name) => deviceMap.get(name)!),
    updated: new Date(),
    failedServers: failedServers.length > 0 ? failedServers : undefined,
  }
}

export async function getDevice(device: string): Promise<DeviceData> {
  const nuts = connect()
  const nut = await Promise.any(
    nuts.map(async (nut) => {
      if (await nut.deviceExists(device)) {
        return nut
      }
      throw new Error('Device not found on this server')
    })
  )

  const data = await nut.getData(device)
  const isReachable = data['ups.status']?.value !== upsStatus.DEVICE_UNREACHABLE

  const [rwVars, commands, description] = await Promise.all([
    isReachable ? nut.getRWVars(device) : Promise.resolve([]),
    isReachable ? nut.getCommands(device) : Promise.resolve([]),
    isReachable ? nut.getDescription(device) : Promise.resolve(''),
  ])
  return {
    device: {
      vars: data,
      rwVars,
      description: description === 'Description unavailable' ? '' : description,
      clients: [],
      commands: nut.hasCredentials() ? commands : [],
      name: device,
    },
    updated: new Date(),
  }
}

export async function getAllVarDescriptions(device: string, params: string[]): Promise<VarDescription> {
  try {
    const nuts = connect()
    const data: { [x: string]: string } = {}

    // Find the first NUT server that has the device
    const nut = await Promise.any(
      nuts.map(async (nut) => {
        if (await nut.deviceExists(device)) {
          return nut
        }
        throw new Error('Device not found on this server')
      })
    )

    const descriptions = await Promise.all(params.map((param) => nut.getVarDescription(param, device)))
    params.forEach((param, index) => {
      data[param] = descriptions[index]
    })
    return { data, error: undefined }
  } catch (e: any) {
    return { data: undefined, error: e?.message ?? 'Unknown error' }
  }
}

export async function saveVar(device: string, varName: string, value: string) {
  try {
    const nuts = connect()
    await Promise.all(
      nuts.map(async (nut) => {
        const deviceExists = await nut.deviceExists(device)
        if (deviceExists) {
          await nut.setVar(varName, value, device)
        }
      })
    )
    return { error: undefined }
  } catch (e: any) {
    return { error: e?.message ?? 'Unknown error' }
  }
}

export async function getAllCommands(device: string): Promise<string[]> {
  try {
    const nuts = connect()
    const commands = new Set<string>()

    await Promise.all(
      nuts.map(async (nut) => {
        const deviceExists = await nut.deviceExists(device)
        if (deviceExists) {
          const deviceCommands = await nut.getCommands(device)
          deviceCommands.forEach((command) => commands.add(command))
        }
      })
    )

    return Array.from(commands)
  } catch {
    return []
  }
}

export async function runCommand(device: string, command: string) {
  try {
    const nuts = connect()
    const runPromises = nuts.map(async (nut) => {
      const deviceExists = await nut.deviceExists(device)
      if (deviceExists) {
        await nut.runCommand(command, device)
      }
    })
    await Promise.all(runPromises)
    return { error: undefined }
  } catch (e: any) {
    return { error: e?.message ?? 'Unknown error' }
  }
}

export async function checkSettings(): Promise<boolean> {
  try {
    const settings = getCachedSettings()
    const servers = settings.get('NUT_SERVERS')
    return Array.isArray(servers) && servers.length > 0
  } catch {
    return false
  }
}

export async function getSettings<K extends keyof SettingsType>(key: K): Promise<SettingsType[K]> {
  const settings = getCachedSettings()
  return settings.get(key)
}

export async function setSettings<K extends keyof SettingsType>(key: K, value: SettingsType[K]): Promise<void> {
  const settings = getCachedSettings()
  settings.set(key, value)
}

export async function exportSettings(): Promise<string> {
  const settings = getCachedSettings()
  return settings.export()
}

export async function importSettings(settings: string): Promise<void> {
  const yamlSettings = getCachedSettings()
  yamlSettings.import(settings)
}

export async function updateServers(servers: Array<server>) {
  const settings = getCachedSettings()

  settings.set('NUT_SERVERS', servers)
}

export async function deleteSettings(key: keyof SettingsType) {
  const settings = getCachedSettings()
  settings.delete(key)
}

export async function disconnect() {
  try {
    const settings = getCachedSettings()
    const keysToDelete: (keyof SettingsType)[] = [
      'NUT_SERVERS',
      'INFLUX_HOST',
      'INFLUX_TOKEN',
      'INFLUX_ORG',
      'INFLUX_BUCKET',
    ]

    keysToDelete.forEach((key) => settings.delete(key))
    settingsInstance = null // Reset cached instance
    await watcher.close() // Clean up the watcher
  } catch (e: any) {
    throw new Error(`Failed to disconnect: ${e.message}`)
  }
}

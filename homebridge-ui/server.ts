/* eslint-disable no-console */
import {
  HomebridgePluginUiServer,
  RequestError,
} from '@homebridge/plugin-ui-utils'

import { RingRestClient } from 'ring-client-api/rest-client'
import { controlCenterDisplayName, getSystemId } from '../config.ts'

interface LoginRequest {
  email: string
  password: string
}

interface TokenRequest {
  email: string
  password: string
  code: string
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

class PluginUiServer extends HomebridgePluginUiServer {
  restClient?: RingRestClient

  constructor() {
    super()

    try {
      this.onRequest('/send-code', this.generateCode)
      this.onRequest('/token', this.generateToken)
      this.ready()
    } catch (error) {
      console.error('Failed to initialize plugin UI server', error)
      throw error
    }
  }

  generateCode = async ({ email, password }: LoginRequest) => {
    try {
      const storagePath = this.homebridgeStoragePath
      this.restClient = new RingRestClient({
        email,
        password,
        controlCenterDisplayName,
        systemId: storagePath ? getSystemId(storagePath) : undefined,
      })

      const { refresh_token } = await this.restClient.getCurrentAuth()

      // If we get here, 2fa was not required.  I'm not sure this is possible anymore, but it's here just in case
      return { refreshToken: refresh_token }
    } catch (e: any) {
      const codePrompt = this.restClient?.promptFor2fa

      if (codePrompt) {
        console.log(codePrompt)
        return { codePrompt }
      }

      console.error('Failed to generate Ring refresh token', e)
      throw new RequestError(getErrorMessage(e), e)
    }
  }

  generateToken = async ({ email, password, code }: TokenRequest) => {
    try {
      // use the existing restClient to avoid sending a token again
      this.restClient =
        this.restClient || new RingRestClient({ email, password })

      const authResponse = await this.restClient.getAuth(code)

      return { refreshToken: authResponse.refresh_token }
    } catch (e: any) {
      console.error('Incorrect 2fa Code')
      throw new RequestError('Please check the code and try again', e)
    }
  }
}

function startPluginUiServer() {
  try {
    return new PluginUiServer()
  } catch (error) {
    console.error('Plugin UI server failed to start', error)
    return undefined
  }
}

startPluginUiServer()

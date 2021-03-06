import { syncStaticDir } from "../utils/get-static-dir"
import reporter from "gatsby-cli/lib/reporter"
import chalk from "chalk"
import telemetry from "gatsby-telemetry"
import express from "express"
import inspector from "inspector"
import { initTracer } from "../utils/tracer"
import { detectPortInUseAndPrompt } from "../utils/detect-port-in-use-and-prompt"
import onExit from "signal-exit"
import {
  userPassesFeedbackRequestHeuristic,
  showFeedbackRequest,
} from "../utils/feedback"
import { markWebpackStatusAsPending } from "../utils/webpack-status"

import { IProgram, IDebugInfo } from "./types"
import { interpret } from "xstate"
import { globalTracer } from "opentracing"
import { developMachine } from "../state-machines/develop"
import { logTransitions } from "../utils/state-machine-logging"

const tracer = globalTracer()

// const isInteractive = process.stdout.isTTY

// Watch the static directory and copy files to public as they're added or
// changed. Wait 10 seconds so copying doesn't interfere with the regular
// bootstrap.
setTimeout(() => {
  syncStaticDir()
}, 10000)

// Time for another story...
// When the parent process is killed by SIGKILL, Node doesm't kill spawned child processes
// Hence, we peiodically send a heart beat to the parent to check if it is still alive
// This will crash with Error [ERR_IPC_CHANNEL_CLOSED]: Channel closed
// and kill the orphaned child process as a result
if (process.send) {
  setInterval(() => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    process.send!({
      type: `HEARTBEAT`,
    })
  }, 1000)
}

onExit(() => {
  telemetry.trackCli(`DEVELOP_STOP`)
})

process.on(`message`, msg => {
  if (msg.type === `COMMAND` && msg.action.type === `EXIT`) {
    process.exit(msg.action.payload)
  }
})

interface IDevelopArgs extends IProgram {
  debugInfo: IDebugInfo | null
}

const openDebuggerPort = (debugInfo: IDebugInfo): void => {
  if (debugInfo.break) {
    inspector.open(debugInfo.port, undefined, true)
    // eslint-disable-next-line no-debugger
    debugger
  } else {
    inspector.open(debugInfo.port)
  }
}

module.exports = async (program: IDevelopArgs): Promise<void> => {
  if (program.verbose) {
    reporter.setVerbose(true)
  }

  if (program.debugInfo) {
    openDebuggerPort(program.debugInfo)
  }

  // We want to prompt the feedback request when users quit develop
  // assuming they pass the heuristic check to know they are a user
  // we want to request feedback from, and we're not annoying them.
  process.on(
    `SIGINT`,
    async (): Promise<void> => {
      if (await userPassesFeedbackRequestHeuristic()) {
        showFeedbackRequest()
      }
      process.exit(0)
    }
  )

  if (process.env.GATSBY_EXPERIMENTAL_PAGE_BUILD_ON_DATA_CHANGES) {
    reporter.panic(
      `The flag ${chalk.yellow(
        `GATSBY_EXPERIMENTAL_PAGE_BUILD_ON_DATA_CHANGES`
      )} is not available with ${chalk.cyan(
        `gatsby develop`
      )}, please retry using ${chalk.cyan(`gatsby build`)}`
    )
  }
  initTracer(program.openTracingConfigFile)
  markWebpackStatusAsPending()
  reporter.pendingActivity({ id: `webpack-develop` })
  telemetry.trackCli(`DEVELOP_START`)
  telemetry.startBackgroundUpdate()

  const port =
    typeof program.port === `string` ? parseInt(program.port, 10) : program.port

  try {
    program.port = await detectPortInUseAndPrompt(port)
  } catch (e) {
    if (e.message === `USER_REJECTED`) {
      process.exit(0)
    }

    throw e
  }

  const app = express()
  const parentSpan = tracer.startSpan(`bootstrap`)

  const machine = developMachine.withContext({
    program,
    parentSpan,
    app,
  })

  const service = interpret(machine)

  if (program.verbose) {
    logTransitions(service)
  }

  service.start()
}

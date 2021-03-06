/* Utils */
class Pipe<T> {
  listeners: Array<(arg: T) => unknown> = [];
  fire(arg: T) {
    this.listeners.forEach((listener) => {
      listener(arg);
    });
  }

  listen(subscriber: (arg: T) => unknown) {
    this.listeners.push(subscriber);
  }

  unlisten(toUnlisten: (arg: T) => unknown) {
    this.listeners = this.listeners.filter(
      (listener) => listener !== toUnlisten
    );
  }
}

const httpToWs = (httpUrl: string) => httpUrl.replace(/^http/, "ws");

type SocketStatus =
  | "connecting"
  | "open"
  | "waitingToRetry"
  | "broken"
  | "closed"; // Intentionally closed by user

type SocketEvent =
  | {
      type: "message";
      data: MessageEvent;
    }
  | {
      type: "status";
      status: SocketStatus; // Not sure what to put here.
    };

const nonRetryCodes = [1000];

class StableSocket {
  constructor(url: string) {
    this.eventPipe = new Pipe<SocketEvent>();
    this.url = url;
    this.socket = this.buildSocket();
  }

  private retryDelay = 1000; // really should exp backoff here but whatevs.
  private shouldRetry = true;
  private url: string;
  private socket: WebSocket;
  private eventPipe: Pipe<SocketEvent>;
  private sendBuffer: string[] = [];

  buildSocket() {
    this.setStatus("connecting");

    this.socket = new WebSocket(this.url);
    this.socket.onmessage = (msg: MessageEvent) => {
      this.eventPipe.fire({
        type: "message",
        data: msg,
      });
    };
    this.socket.onopen = () => {
      this.setStatus("open");
      this.flush();
    };
    this.socket.onclose = ({ code }) => {
      if (this.shouldRetry && !nonRetryCodes.includes(code)) {
        this.setStatus("waitingToRetry");
        setTimeout(() => this.buildSocket(), this.retryDelay);
      } else {
        this.setStatus("closed");
      }
    };
    this.socket.onerror = (ev) => {
      console.warn("Underlying Socket Error", ev);
      this.setStatus("broken");
      this.close();
    };
    return this.socket;
  }

  private setStatus(newStatus: SocketStatus) {
    this.eventPipe.fire({
      type: "status",
      status: newStatus,
    });
  }

  private flush() {
    if (this.socket.readyState !== this.socket.OPEN) {
      return;
    }
    for (let msg of this.sendBuffer) {
      this.socket.send(msg);
    }
    this.sendBuffer = [];
  }

  // i don't know why out of 65536, but it just felt right.
  //nonce = Math.floor(Math.random() * 65536);
  send(msg: string) {
    this.sendBuffer.push(msg);
    this.flush();
  }

  listen(listener: (arg: SocketEvent) => unknown) {
    this.eventPipe.listen(listener);
  }

  unlisten(listener: (arg: SocketEvent) => unknown) {
    this.eventPipe.unlisten(listener);
  }

  close(code: number = 1000) {
    // one final flush for last measure!
    this.flush();
    this.shouldRetry = false;
    this.socket.close(code);
  }
}

type CloseStatus = "broken" | "closed";

export class ButteryChannelConnection<Send, Recv> {
  constructor(
    url: string,
    sendNode: ButteryNode<Send>,
    recvNode: ButteryNode<Recv>
  ) {
    this.sendNode = sendNode;
    this.recvNode = recvNode;

    this.stableSocket = new StableSocket(httpToWs(url));
    this.recvPipe = new Pipe<Recv>();
    this.closePipe = new Pipe<CloseStatus>();

    this.stableSocket.listen((msg) => {
      if (msg.type === "message") {
        const deserialized = recvNode.deserialize(msg.data.data);
        if (deserialized) {
          this.recvPipe.fire(deserialized);
        }
      }
      if (
        msg.type === "status" &&
        (msg.status === "broken" || msg.status === "closed")
      ) {
        this.closePipe.fire(msg.status);
        this.closeStatus = msg.status;
      }
    });
  }

  private sendNode: ButteryNode<Send>;
  private recvNode: ButteryNode<Recv>;
  private stableSocket: StableSocket;
  private recvPipe: Pipe<Recv>;
  private closePipe: Pipe<CloseStatus>;
  private closeStatus?: CloseStatus;

  send(data: Send) {
    if (this.closeStatus) {
      throw "Pipe closed!";
    }
    const serialized = this.sendNode.serialize(data);
    if (serialized) {
      this.stableSocket.send(serialized);
    }
  }

  listen(listener: (arg: Recv) => unknown) {
    this.recvPipe.listen(listener);
  }

  unlisten(listener: (arg: Recv) => unknown) {
    this.recvPipe.unlisten(listener);
  }

  onClose(listener: (arg: CloseStatus) => unknown) {
    this.closePipe.listen(listener);
  }

  removeOnClose(listener: (arg: CloseStatus) => unknown) {
    this.closePipe.listen(listener);
  }

  close(code: number = 1000) {
    this.stableSocket.close(code);
  }
}

/* */

interface RpcConfig {
  requester?: (
    url: string,
    body: string,
    config?: RpcConfig
  ) => Promise<string>;
  mode?: string;
  cache?: string;
  credentials?: string;
  headers?: { [key: string]: string };
  redirect?: string;
  referrerPolicy?: string;
}

const defaultHeaders = {
  "Content-Type": "application/json",
};

interface ButteryClientConfig {
  rpc?: RpcConfig;
}

const defaultRequester = (
  url: string,
  body: string,
  config: RpcConfig = {}
) => {
  let headers = defaultHeaders;
  if (config.headers) {
    headers = {
      ...headers,
      ...config.headers,
    };
  }
  return fetch(url, {
    method: "post",
    body,
    headers,
  }).then((response) => response.text());
};

export function buildRpcHandler<Req, Res>(
  requestName: string,
  requestNode: ButteryNode<Req>,
  responseNode: ButteryNode<Res>
) {
  return function Request(this: ButteryClient, value: Req): Promise<Res> {
    return this.request(requestName, value, requestNode, responseNode);
  };
}

export function buildChannelHandler<Send, Recv>(
  requestName: string,
  sendNode: ButteryNode<Send>,
  recvNode: ButteryNode<Recv>
) {
  return function Connect(
    this: ButteryClient
  ): ButteryChannelConnection<Send, Recv> {
    return this.connect(requestName, sendNode, recvNode);
  };
}

export class ButteryClient {
  constructor(baseUrl: string, ButteryClientConfig: ButteryClientConfig = {}) {
    this.baseUrl = baseUrl;
    this.requester = ButteryClientConfig.rpc?.requester || defaultRequester;
    this.rpcConfig = ButteryClientConfig.rpc || {};
    this.serviceName = "TO_OVERRIDE";
  }

  baseUrl: string;
  serviceName: string;
  butteryApiNamespace = "__buttery__";
  rpcConfig: RpcConfig;
  requester: (url: string, body: string, config: RpcConfig) => Promise<string>;

  request<Req, Res>(
    requestName: string,
    requestValue: Req,
    requestNode: ButteryNode<Req>,
    responseNode: ButteryNode<Res>
  ): Promise<Res> {
    const targetUrl = `${this.baseUrl}/${this.butteryApiNamespace}/${this.serviceName}/${requestName}`;
    const body = requestNode.serialize(requestValue);
    if (body === undefined) {
      throw "Unacceptable Body Type";
    }
    return this.requester(targetUrl, body, this.rpcConfig).then((result) => {
      const parsed = responseNode.deserialize(result);
      if (parsed === undefined) {
        throw "Was not able to parse server response";
      }
      return parsed;
    });
  }

  connect<Send, Recv>(
    requestName: string,
    sendNode: ButteryNode<Send>,
    recvNode: ButteryNode<Recv>
  ) {
    return new ButteryChannelConnection(
      `${this.baseUrl}/${this.butteryApiNamespace}/${this.serviceName}/${requestName}`,
      sendNode,
      recvNode
    );
  }
}

import type { RecordingPacket } from 'homebridge'

interface Mp4Box {
  type: string
  box: Buffer
}

function* parseMp4Boxes(data: Buffer): Generator<Mp4Box> {
  let offset = 0

  while (offset + 8 <= data.length) {
    const shortLength = data.readUInt32BE(offset)
    let boxLength = shortLength
    let headerLength = 8

    if (shortLength === 1) {
      if (offset + 16 > data.length) {
        break
      }

      boxLength = Number(data.readBigUInt64BE(offset + 8))
      headerLength = 16
    } else if (shortLength === 0) {
      break
    }

    if (boxLength < headerLength || offset + boxLength > data.length) {
      break
    }

    const box = data.subarray(offset, offset + boxLength),
      type = box.subarray(4, 8).toString('ascii')

    yield { type, box }

    offset += boxLength
  }
}

export class FragmentedMp4Parser {
  private pendingData: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private initBoxes: Buffer[] = []
  private initSent = false
  private fragmentBoxes: Buffer[] = []

  get hasInitializationSegment() {
    return this.initSent
  }

  append(data: Buffer) {
    const packets: RecordingPacket[] = []
    this.pendingData = this.pendingData.length
      ? Buffer.concat([this.pendingData, data])
      : data

    let consumed = 0

    for (const { type, box } of parseMp4Boxes(this.pendingData)) {
      consumed += box.length

      if (!this.initSent) {
        this.initBoxes.push(box)

        if (type === 'moov') {
          packets.push({
            data: Buffer.concat(this.initBoxes) as Buffer,
            isLast: false,
          })
          this.initBoxes = []
          this.initSent = true
        }

        continue
      }

      if (type === 'styp') {
        this.fragmentBoxes = [box]
        continue
      }

      if (type === 'moof') {
        this.fragmentBoxes = this.fragmentBoxes.length
          ? [...this.fragmentBoxes, box]
          : [box]
        continue
      }

      if (!this.fragmentBoxes.length) {
        continue
      }

      this.fragmentBoxes.push(box)

      if (type === 'mdat') {
        packets.push({
          data: Buffer.concat(this.fragmentBoxes) as Buffer,
          isLast: false,
        })
        this.fragmentBoxes = []
      }
    }

    if (consumed > 0) {
      this.pendingData = this.pendingData.subarray(consumed)
    }

    return packets
  }
}

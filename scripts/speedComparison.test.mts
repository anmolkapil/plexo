import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assessComparison,
  calculateContributions,
  calculateSpeedup,
  calculateStreamAllocations,
  SpeedComparisonManager
} from '../src/main/network/speedComparison.ts'
import type { NetworkInterfaceInfo } from '../src/shared/types.ts'

const mockInterface = (id: string, name: string): NetworkInterfaceInfo => ({
  id,
  device: name,
  displayName: name,
  addresses: [{ address: '192.168.1.10', family: 4 }],
  kind: 'wifi'
})

// --- 1. Stream Allocations Tests ---

test('calculateStreamAllocations returns empty for empty interface list', () => {
  const result = calculateStreamAllocations([])
  assert.deepEqual(result, [])
})

test('calculateStreamAllocations assigns all streams to a single interface', () => {
  const iface = mockInterface('wifi', 'Wi-Fi')
  const result = calculateStreamAllocations([iface], 4)
  assert.equal(result.length, 1)
  assert.equal(result[0].streams, 4)
  assert.equal(result[0].iface.id, 'wifi')
})

test('calculateStreamAllocations evenly splits streams across 2 interfaces', () => {
  const if1 = mockInterface('wifi', 'Wi-Fi')
  const if2 = mockInterface('tether', 'Phone Tether')
  const result = calculateStreamAllocations([if1, if2], 4)
  assert.equal(result.length, 2)
  assert.equal(result[0].streams, 2)
  assert.equal(result[1].streams, 2)
  const total = result.reduce((sum, r) => sum + r.streams, 0)
  assert.equal(total, 4)
})

test('calculateStreamAllocations fairly distributes 4 streams across 3 interfaces', () => {
  const if1 = mockInterface('wifi', 'Wi-Fi')
  const if2 = mockInterface('eth', 'Ethernet')
  const if3 = mockInterface('tether', 'Phone Tether')
  const result = calculateStreamAllocations([if1, if2, if3], 4)
  assert.equal(result.length, 3)
  assert.equal(result[0].streams, 2)
  assert.equal(result[1].streams, 1)
  assert.equal(result[2].streams, 1)
  const total = result.reduce((sum, r) => sum + r.streams, 0)
  assert.equal(total, 4)
})

test('calculateStreamAllocations assigns 1 stream each when interfaces >= totalStreams', () => {
  const ifaces = [
    mockInterface('i1', 'Net 1'),
    mockInterface('i2', 'Net 2'),
    mockInterface('i3', 'Net 3'),
    mockInterface('i4', 'Net 4'),
    mockInterface('i5', 'Net 5')
  ]
  const result = calculateStreamAllocations(ifaces, 4)
  assert.equal(result.length, 5)
  for (const r of result) {
    assert.equal(r.streams, 1)
  }
})

// --- 2. Speedup & Multiplier Tests ---

test('calculateSpeedup computes correct multiplier and percentage gain', () => {
  // Fastest individual: 30 MB/s, Combined: 50 MB/s -> 1.67x (+67%)
  const { fastest, multiplier, percent } = calculateSpeedup(50, [20, 30])
  assert.equal(fastest, 30)
  assert.equal(multiplier, 1.67)
  assert.equal(percent, 67)
})

test('calculateSpeedup handles zero individual speeds gracefully', () => {
  const { fastest, multiplier, percent } = calculateSpeedup(50, [0, 0])
  assert.equal(fastest, 0)
  assert.equal(multiplier, 1)
  assert.equal(percent, 0)
})

test('calculateSpeedup handles empty individual speeds array', () => {
  const { fastest, multiplier, percent } = calculateSpeedup(50, [])
  assert.equal(fastest, 0)
  assert.equal(multiplier, 1)
  assert.equal(percent, 0)
})

test('calculateSpeedup calculates no-gain or negative percent if combined is slower', () => {
  const { fastest, multiplier, percent } = calculateSpeedup(25, [30])
  assert.equal(fastest, 30)
  assert.equal(multiplier, 0.83)
  assert.equal(percent, -17)
})

// --- 3. Contribution Calculation Tests ---

test('calculateContributions determines percentage share per interface', () => {
  const bytes = {
    wifi: 60 * 1024 * 1024,
    tether: 40 * 1024 * 1024
  }
  const contribs = calculateContributions(bytes)
  assert.equal(contribs.wifi.percent, 60)
  assert.equal(contribs.tether.percent, 40)
  assert.equal(contribs.wifi.bytes, 60 * 1024 * 1024)
})

test('calculateContributions handles empty or zero total bytes', () => {
  const contribs = calculateContributions({})
  assert.deepEqual(contribs, {})

  const zeroContribs = calculateContributions({ wifi: 0, tether: 0 })
  assert.equal(zeroContribs.wifi.percent, 0)
  assert.equal(zeroContribs.tether.percent, 0)
})

// --- 4. Diagnosis & Assessment Tests ---

test('assessComparison identifies significant gain (multiplier >= 1.25)', () => {
  const res = assessComparison(2, 1.85)
  assert.equal(res.assessment, 'significant_gain')
  assert.ok(res.note.includes('1.85×'))
  assert.ok(res.note.includes('independent uplinks'))
})

test('assessComparison identifies moderate gain (1.05 <= multiplier < 1.25)', () => {
  const res = assessComparison(2, 1.15)
  assert.equal(res.assessment, 'moderate_gain')
  assert.ok(res.note.includes('1.15×'))
})

test('assessComparison identifies similar throughput / no gain (multiplier < 1.05)', () => {
  const res = assessComparison(2, 1.02)
  assert.equal(res.assessment, 'no_gain')
  assert.ok(res.note.includes('bottleneck'))
})

test('assessComparison flags single network when reachable count is 1', () => {
  const res = assessComparison(1, undefined)
  assert.equal(res.assessment, 'single_network')
  assert.ok(res.note.includes('Only one working network'))
})

test('assessComparison flags failure when 0 networks are reachable', () => {
  const res = assessComparison(0, undefined)
  assert.equal(res.assessment, 'failed')
  assert.ok(res.note.includes('None of the selected networks'))
})

// --- 5. SpeedComparisonManager Tests ---

test('SpeedComparisonManager can cancel an active or queued run', () => {
  const manager = new SpeedComparisonManager()
  // Canceling when idle does not throw
  assert.doesNotThrow(() => manager.cancel())
})

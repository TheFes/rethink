import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { ERRORS, COURSES, TEMPERATURES, SPINS } from './washer_common'
import { Enum } from '@/util/enum'

// Codes derived from modelJSON & observation of the LG app.
const STATUS = Enum.of({
    Off: 0,
    Standby: 1,
    Paused: 2,
    Delayed: 3,
    Detecting: 4,
    Washing: 6,
    Rinsing: 7,
    Spinning: 8,
    Drying: 9,
    End: 10,
    'Cool down': 11,
    'Rinse hold': 12,
    Refreshing: [14, 15], // WASH_REFRESHING & REFRESHING,
    // the app shows the first one as a wash state, the second as a sub-state of Completed
    Demo: 16,
    Error: 18,
})

// F_C__Y___W.A__QEUK — LG F4WV709P1, front-loading washer, A-generation UK
// 62-byte AABB status packet (0x20 0xEC subtype).
// Offsets confirmed from live captures against known settings:
//   Cotton/40°C/1400RPM/Normal-rinse, delayed-start 4h, tub-clean-counter=9, remote-start=off.
// The plain start command (F024 05) always runs the default programme (Cotton 40 °C 1400 rpm), whatever
// the panel shows. A remote start of a chosen programme needs F026, which carries the whole programme
// and starts it; there is no command that only configures. So the set_* selects below are held here
// until Run programme is pressed, each defaulting to what the appliance last reported.

// What the LG app sent for soil level and rinse in every captured F026, for three different courses
// (SOILWASH_NORMAL, RINSE_NORMAL). Used when the appliance reports nothing, e.g. while asleep.
const DEFAULT_SOIL = 3
const DEFAULT_RINSE = 1

// Programme options, each set on the panel and echoed by the LG app in the F026 that started a Cotton
// wash (capture 2026-11-26). Intensive and extra rinse are values of the soil and rinse bytes, prewash
// and wrinkle care are bits that sit in the same place as in the status record.
const INTENSIVE_SOIL = 4 // rec[9] and F026 soil: 3 → 4
const EXTRA_RINSE = 2 // rec[12] and F026 rinse: 1 → 2 (panel: Spoelen+)
const PREWASH = 0x40 // rec[16] bit6 and the F026 options byte
const WRINKLE_CARE = 0x20 // rec[17] bit5 and the F026 flags byte (0x03 → 0x23)
// The LG app leaves steam out of its F026 (it sent 40 °C and spin 0xFF, and the wash ran without steam),
// but the options byte takes the status bit, as it does for prewash: Cotton 60 °C 1400 rpm with 0x80
// started with steam on (2026-11-26). The panel raises Cotton to 60 °C when steam is switched on.
const STEAM = 0x80 // rec[16] bit7 and the F026 options byte
const OPTIONS = ['prewash', 'steam', 'wrinkle_care', 'intensive', 'extra_rinse'] as const
type Option = (typeof OPTIONS)[number]

export default class Device extends AABBDevice {
    // Tracks the last status byte from 0xEC/0xEB so the 0xD8 handler can
    // suppress spurious door_lock=OFF messages during active-cycle states.
    private lastStatus = -1
    /** Programme settings chosen in HA but not yet run, as wire codes. Cleared once run. */
    private pending = new Map<'course' | 'spin' | 'temp', number>()
    /** The programme the appliance last reported; 0 means not selected. */
    private reported = { course: 0, soil: 0, spin: 0, temp: 0, rinse: 0, options: 0, flags: 0 }
    /** Options switched in HA but not yet run. Cleared once run. */
    private pendingOptions = new Map<Option, boolean>()

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        // Needs the cloud's acks. Unacked, this family retransmits then re-deploys, which HA shows
        // as on/unavailable. Bridged cloud acks are also suppressed once a handler exists.
        super(HA, thinq, true)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer' }),
                components: {
                    power: {
                        platform: 'switch',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
                        name: '',
                        icon: 'mdi:washing-machine',
                    },
                    start: {
                        platform: 'button',
                        unique_id: '$deviceid-start',
                        command_topic: '$this/start/set',
                        payload_press: '',
                        name: 'Start',
                        icon: 'mdi:play-circle-outline',
                    },
                    pause: {
                        platform: 'button',
                        unique_id: '$deviceid-pause',
                        command_topic: '$this/pause/set',
                        payload_press: '',
                        name: 'Pause',
                        icon: 'mdi:pause-circle-outline',
                    },
                    set_course: {
                        platform: 'select',
                        unique_id: '$deviceid-set_course',
                        state_topic: '$this/set_course',
                        command_topic: '$this/set_course/set',
                        name: 'Set course',
                        icon: 'mdi:tune-vertical',
                        options: COURSES.options,
                    },
                    set_temp: {
                        platform: 'select',
                        unique_id: '$deviceid-set_temp',
                        state_topic: '$this/set_temp',
                        command_topic: '$this/set_temp/set',
                        name: 'Set temperature',
                        icon: 'mdi:thermometer',
                        options: TEMPERATURES.options,
                    },
                    set_spin: {
                        platform: 'select',
                        unique_id: '$deviceid-set_spin',
                        state_topic: '$this/set_spin',
                        command_topic: '$this/set_spin/set',
                        name: 'Set spin',
                        icon: 'mdi:autorenew',
                        options: SPINS.options,
                    },
                    set_prewash: {
                        platform: 'switch',
                        unique_id: '$deviceid-set_prewash',
                        state_topic: '$this/set_prewash',
                        command_topic: '$this/set_prewash/set',
                        name: 'Set prewash',
                        icon: 'mdi:water-plus-outline',
                    },
                    set_steam: {
                        platform: 'switch',
                        unique_id: '$deviceid-set_steam',
                        state_topic: '$this/set_steam',
                        command_topic: '$this/set_steam/set',
                        name: 'Set steam',
                        icon: 'mdi:kettle-steam',
                    },
                    set_wrinkle_care: {
                        platform: 'switch',
                        unique_id: '$deviceid-set_wrinkle_care',
                        state_topic: '$this/set_wrinkle_care',
                        command_topic: '$this/set_wrinkle_care/set',
                        name: 'Set wrinkle care',
                        icon: 'mdi:tshirt-crew-outline',
                    },
                    set_intensive: {
                        platform: 'switch',
                        unique_id: '$deviceid-set_intensive',
                        state_topic: '$this/set_intensive',
                        command_topic: '$this/set_intensive/set',
                        name: 'Set intensive',
                        icon: 'mdi:arm-flex-outline',
                    },
                    set_extra_rinse: {
                        platform: 'switch',
                        unique_id: '$deviceid-set_extra_rinse',
                        state_topic: '$this/set_extra_rinse',
                        command_topic: '$this/set_extra_rinse/set',
                        name: 'Set extra rinse',
                        icon: 'mdi:water-sync',
                    },
                    run_programme: {
                        platform: 'button',
                        unique_id: '$deviceid-run_programme',
                        command_topic: '$this/run_programme/set',
                        payload_press: '',
                        name: 'Run programme',
                        icon: 'mdi:play-box-outline',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        device_class: 'enum',
                        options: STATUS.options,
                    },
                    error: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-error',
                        state_topic: '$this/error',
                        name: 'Error',
                        icon: 'mdi:check-circle',
                        device_class: 'problem',
                        entity_category: 'diagnostic',
                    },
                    error_message: {
                        platform: 'sensor',
                        unique_id: '$deviceid-error-message',
                        state_topic: '$this/error_message',
                        name: 'Error message',
                        icon: 'mdi:alert-circle-outline',
                        device_class: 'enum',
                        entity_category: 'diagnostic',
                        options: ERRORS.options,
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:pin-outline',
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        device_class: 'enum',
                        options: TEMPERATURES.options,
                    },
                    spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin',
                        icon: 'mdi:autorenew',
                        device_class: 'enum',
                        options: SPINS.options,
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        icon: 'mdi:play-circle-outline',
                    },
                    door_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door_lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                        device_class: 'lock',
                    },
                    steam: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-steam',
                        state_topic: '$this/steam',
                        name: 'Steam',
                        icon: 'mdi:kettle-steam',
                    },
                    wrinkle_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-wrinkle_care',
                        state_topic: '$this/wrinkle_care',
                        name: 'Wrinkle care',
                        icon: 'mdi:tshirt-crew-outline',
                    },
                    prewash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-prewash',
                        state_topic: '$this/prewash',
                        name: 'Prewash',
                        icon: 'mdi:water-plus-outline',
                    },
                    intensive: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-intensive',
                        state_topic: '$this/intensive',
                        name: 'Intensive',
                        icon: 'mdi:arm-flex-outline',
                    },
                    extra_rinse: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-extra_rinse',
                        state_topic: '$this/extra_rinse',
                        name: 'Extra rinse',
                        icon: 'mdi:water-sync',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        icon: 'mdi:account-lock',
                        device_class: 'lock',
                        entity_category: 'diagnostic',
                    },
                    active: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-active',
                        state_topic: '$this/active',
                        name: 'Active',
                        icon: 'mdi:washing-machine',
                    },
                    sleep: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-sleep',
                        state_topic: '$this/sleep',
                        name: 'Sleep',
                        icon: 'mdi:sleep',
                    },
                    tub_clean_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-tub_clean_count',
                        state_topic: '$this/tub_clean_count',
                        name: 'Washes since drum clean',
                        icon: 'mdi:washing-machine-alert',
                        entity_category: 'diagnostic',
                    },
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Initial time',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Remaining time',
                    },
                    delay_remaining: {
                        platform: 'sensor',
                        unique_id: '$deviceid-delay_remaining',
                        state_topic: '$this/delay_remaining',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Delay remaining',
                        icon: 'mdi:clock-start',
                    },
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from('F0ED1121010000001800', 'hex'))
    }

    // Confirmed offsets, relative to the start of a 30-byte status record (rec[0:2] is a
    // constant "00 1c" marker, unused):
    //   [2]     status           — STATES[3]='Delayed' confirmed
    //   [3][4]  remaining_time   — counts down during wash; equals initial when delayed
    //                            NOTE: shows 0 briefly at wash start (load-measuring phase)
    //   [5][6]  initial_time     — fixed total program duration (72 min confirmed, stays constant)
    //   [7]     course           — COURSES index; matches the LG cloud's course reports (COTTON=0x01,
    //                            EASYCARE=0x02, COTTONPLUS=0x04, SPEED14=0x0C) and the course byte of the
    //                            F026 commands that started them (capture 2026-11-26). 0 when not selected.
    //   [8]     error_code       — ERRORS index; 0=OK; 0x01=DE2 (door lock error) confirmed via
    //                            live dE2 capture 2026-08-02.
    //   [9]     soil level       — 3 with the cloud's SOILWASH_NORMAL, 4 with Intensive on the panel
    //                            (capture 2026-11-26); 0 when not selected
    //   [10]    spin index       — SPINS[10]=1400 RPM confirmed
    //   [11]    temp index       — TEMPERATURES[4]=40°C confirmed
    //   [12]    rinse            — 1 with the cloud's RINSE_NORMAL, 2 with Spoelen+ (extra rinse) on the
    //                            panel (capture 2026-11-26); 0 when not selected and once the
    //                            rinses are done. Not the course: it stayed 1 for Quick 14, Eco and Ease Care.
    //   [14]    delay hours      — 4 confirmed
    //   [15]    delay minutes    — counts down 1/min confirmed
    //   [16]    bit7=steam       — 0x80=steam ON; confirmed via steam-toggle experiment
    //           bit6=prewash     — 0x40=prewash ON; toggled on the panel (capture 2026-11-26)
    //   [17]    bit1=remote_start — matches the LG cloud's remoteStart ON/OFF reports (capture 2026-11-25);
    //                            the device also sends a 0x72 packet (c9=on, c8=off) at each change
    //           bit6=active      — set once start is pressed; through Measuring/Delayed/Washing/Rinsing/Spinning/End.
    //                            Also follows the LG cloud's doorLock reports in Standby: set while remote start
    //                            holds the door locked, cleared when the panel sleeps (capture 2026-11-25)
    //           bit7=child_lock  — confirmed via live capture 2026-07-15 (0xC0=active+child_lock ON, 0x40=active only)
    //           bit5=wrinkle_care — 0x20=wrinkle care ON; confirmed via live capture 2026-09-04 (0x60=active+wrinkle
    //                            care ON for the whole cycle, vs 0x40=active only on an otherwise identical wash).
    //                            NOT byte [16] bit5, despite steam living in that byte — the two settings sit in
    //                            different bytes on this model.
    //   [20]    unknown          — varies; 0x03 in Off/Washing, 0x06 in Delayed/Spinning/End
    //   [21]    unknown          — mirrors status during an active cycle; not exposed to HA
    //                            (rethink convention: previous/derived state fields are internal-only,
    //                            see e.g. STUDIO_HOOD's "previous state" block)
    //   [23]    tub_clean_count  — 9 during wash; increments to 10 on End packet confirmed
    //   [29]    bit0=sleep       — panel asleep after ~15 min idle; matches the LG cloud's STANDBY_ON/OFF
    //                            (capture 2026-11-25). Status stays Standby and course/spin/temp clear.
    //                            The power ON command (F02A0100) wakes it, as the cloud's wake_up does.
    // End state: status=0x0A, spin/temp go to 0x00 ('Not selected'), course is kept, remaining=0,
    // tub_clean_count++. Power stays ON during End (status>0); goes OFF only when status=0x00 ('Off').
    private processRecord(rec: Buffer) {
        const status = rec[2]
        this.lastStatus = status
        const remain_h = rec[3] // remaining_time hours (counts down; 0 briefly during load-measuring)
        const remain_m = rec[4] // remaining_time minutes
        const initial_h = rec[5] // initial_time hours (fixed for the lifetime of the program)
        const initial_m = rec[6] // initial_time minutes
        const error_code = rec[8]
        const spin = rec[10]
        const temp = rec[11] // 0x00 during rinse (cold water) → publishes undefined/'None', expected
        const course = rec[7]
        const delay_h = rec[14]
        const delay_m = rec[15]
        const steam = rec[16] & 0x80 // bit7: 0x80=steam ON
        const remote_start = rec[17] & 0x02 // bit1: remote start enabled
        const active = rec[17] & 0x40 // bit6: program active (set once start pressed, through End)
        const wrinkle_care = rec[17] & 0x20 // bit5: 0x20=wrinkle care ON
        const child_lock = rec[17] & 0x80 // bit7: child lock engaged
        const tub_clean_count = rec[23]
        const sleep = rec[29] & 0x01

        this.publishProperty('power', status > 0 ? 'ON' : 'OFF')
        this.publishProperty('status', STATUS.map(status))
        this.publishProperty('error_message', ERRORS.map(error_code))
        this.publishProperty('error', error_code ? 'ON' : 'OFF')
        this.publishProperty('course', COURSES.map(course))
        this.publishProperty('spin', SPINS.map(spin))
        this.publishProperty('temp', TEMPERATURES.map(temp))
        this.publishProperty('remaining_time', remain_h * 60 + remain_m)
        this.publishProperty('initial_time', initial_h * 60 + initial_m)
        this.publishProperty('delay_remaining', delay_h * 60 + delay_m)
        this.publishProperty('remote_start', remote_start ? 'ON' : 'OFF')
        this.publishProperty('steam', steam ? 'ON' : 'OFF')
        this.publishProperty('wrinkle_care', wrinkle_care ? 'ON' : 'OFF')
        this.publishProperty('prewash', rec[16] & PREWASH ? 'ON' : 'OFF')
        this.publishProperty('intensive', rec[9] === INTENSIVE_SOIL ? 'ON' : 'OFF')
        this.publishProperty('extra_rinse', rec[12] === EXTRA_RINSE ? 'ON' : 'OFF')
        this.publishProperty('active', active ? 'ON' : 'OFF')
        this.publishProperty('child_lock', child_lock ? 'OFF' : 'ON')
        this.publishProperty('tub_clean_count', tub_clean_count)
        this.publishProperty('sleep', sleep ? 'ON' : 'OFF')

        const previous = this.reported
        const previousOptions = OPTIONS.map((o) => [o, this.reportedOption(o)] as const)
        this.reported = { course, soil: rec[9], spin, temp, rinse: rec[12], options: rec[16], flags: rec[17] }
        // A change made on the panel replaces what was set in HA for that setting, so the selects
        // and switches keep following the panel. Only while a programme is selected on both sides:
        // sleep, Off and waking clear or restore everything, which is not a choice made on the panel.
        if (previous.course && course && !sleep) {
            for (const prop of ['course', 'spin', 'temp'] as const) {
                if (previous[prop] !== this.reported[prop]) this.pending.delete(prop)
            }
            for (const [option, was] of previousOptions) {
                if (was !== this.reportedOption(option)) this.pendingOptions.delete(option)
            }
        }
        this.publishSettings()

        // Derive door_lock from status for Delayed and active-cycle states where
        // 0xD8 packets are not emitted. HA device_class='lock': OFF=Locked, ON=Unlocked.
        // Off(0) → unlocked → ON; Standby(1) → rec[17] bit6; everything else → locked → OFF.
        // In Standby the door locks when remote start is enabled, without any 0xD8 packet, and
        // rec[17] bit6 matched every cloud doorLock report. The 0xD8 sent at power-on (0x22) did
        // not coincide with one, so 0xD8 transitions in Standby are not treated as lock changes.
        if (status === 0) this.publishProperty('door_lock', 'ON')
        else if (status === 1) this.publishProperty('door_lock', active ? 'OFF' : 'ON')
        else this.publishProperty('door_lock', 'OFF')
    }

    processAABB(buf: Buffer) {
        // 0xEC = 62-byte status packet: two back-to-back 30-byte records, [old][new] — the
        //        device echoes its previous record before the current one. Confirmed by
        //        comparing consecutive captures: record 2 of packet N always equals record 1
        //        of packet N+1 (verified across normal polling, rapid option-scrolling, and a
        //        real dE2 error transition). We read record 2 (buf[32:62]), the current state.
        // 0xEB = 32-byte single-record compact packet (sent after commands/reconnect); the
        //        single record uses the same relative layout as 0xEC's current record.
        // 0xE2 = 32-byte end-of-cycle alert packet: floods at ~2s intervals during End
        //        state. Has a different field layout ([4]≠status, [5][6]≠time); [12][13][14]
        //        and [25] coincidentally sit at the same offsets but [4]=0x04='Measuring'
        //        would be wrong to publish. Silently ignored.
        // 0xD8 = 3-byte door-state packet: floods at ~2s intervals during door interaction
        //        and cycle startup. buf[2]=0x00=door not machine-locked (accessible);
        //        non-zero=door machine-locked (0x30 observed at cycle start, 0x0B also seen).
        //        This is the sole source of door_lock state — the lock_status byte's bit6 is
        //        unused on this model and never changes.
        const isE2 = buf.length === 32 && buf[0] === 0x20 && buf[1] === 0xe2
        const isD8 = buf.length === 3 && buf[0] === 0x20 && buf[1] === 0xd8
        if (isE2) return

        if (isD8) {
            // Non-zero = door machine-locked; 0x00 = not machine-locked.
            // HA binary_sensor device_class='lock': OFF=Locked (Vergrendeld), ON=Unlocked (Ontgrendeld).
            // Only used before a status record arrives or while Off. In Standby rec[17] bit6 is
            // authoritative, and during a cycle the machine can send 0xD8 buf[2]=0x00 spuriously
            // (e.g. on child-lock toggle), which would otherwise incorrectly override the
            // status-derived door_lock=OFF.
            if (this.lastStatus <= 0) this.publishProperty('door_lock', buf[2] ? 'OFF' : 'ON')
            return
        }

        this.processCommonStatus(buf, 0x20, 30, this.processRecord)
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'power') {
            if (mqttValue === 'ON') {
                this.send(Buffer.from('F02A0100', 'hex'))
            } else if (mqttValue === 'OFF') {
                this.send(Buffer.from('F024010100', 'hex'))
            }
        }

        if (prop === 'pause') this.send(Buffer.from('F024040100', 'hex'))
        if (prop === 'start') this.send(Buffer.from('F024050100', 'hex'))

        if (prop === 'run_programme') {
            const command = this.programmeCommand()
            if (!command) {
                this.log('run_programme: course, spin or temperature not selected, nothing sent')
                return
            }
            this.send(command)
            // The appliance is the authority on what runs now; follow it again.
            this.pending.clear()
            this.pendingOptions.clear()
            this.publishSettings()
            return
        }

        const option = OPTIONS.find((o) => prop === `set_${o}`)
        if (option) {
            if (mqttValue === 'ON' || mqttValue === 'OFF') this.pendingOptions.set(option, mqttValue === 'ON')
            this.publishSettings()
            return
        }

        const table = { set_course: COURSES, set_temp: TEMPERATURES, set_spin: SPINS }
        if (prop in table) {
            const code = table[prop as keyof typeof table].unmap(mqttValue)
            if (code !== undefined) this.pending.set(prop.slice(4) as 'course' | 'spin' | 'temp', code)
            this.publishSettings()
        }
    }

    private setting(prop: 'course' | 'spin' | 'temp') {
        return this.pending.get(prop) ?? this.reported[prop]
    }

    private option(option: Option) {
        return this.pendingOptions.get(option) ?? this.reportedOption(option)
    }

    private reportedOption(option: Option) {
        const { soil, rinse, options, flags } = this.reported
        if (option === 'prewash') return (options & PREWASH) !== 0
        if (option === 'steam') return (options & STEAM) !== 0
        if (option === 'wrinkle_care') return (flags & WRINKLE_CARE) !== 0
        if (option === 'intensive') return soil === INTENSIVE_SOIL
        return rinse === EXTRA_RINSE
    }

    private publishSettings() {
        this.publishProperty('set_course', COURSES.map(this.setting('course')))
        this.publishProperty('set_temp', TEMPERATURES.map(this.setting('temp')))
        this.publishProperty('set_spin', SPINS.map(this.setting('spin')))
        for (const option of OPTIONS) this.publishProperty(`set_${option}`, this.option(option) ? 'ON' : 'OFF')
    }

    /** The reported value, unless it is the option's value and the option is switched off. */
    private optionValue(reported: number, option: Option, value: number, fallback: number) {
        if (this.option(option)) return value
        return reported && reported !== value ? reported : fallback
    }

    /**
     * F0 26 <course> <soil> <spin> <temp> <rinse> 00 00 00 00 <options> 03 00 00 00 00 00
     *
     * The layout the LG app used for Quick 14, Eco 40-60 and Ease Care (capture 2026-11-26), and the
     * sibling Y_V8_Y___W.B32QEUK's F026. The app copies the panel's options into it: Intensive as soil 4,
     * extra rinse as rinse 2, prewash as 0x40 in <options> and wrinkle care as 0x20 in the byte after it
     * (capture 2026-11-26, one option per start). The app leaves steam out, but the appliance accepts it as
     * 0x80 in <options>. 0x03 is initialBit | remoteStart, as in every captured start.
     * Returns null rather than sending a programme with an unselected course, spin or temperature.
     */
    private programmeCommand() {
        const course = this.setting('course')
        const spin = this.setting('spin')
        const temp = this.setting('temp')
        if (!course || !spin || !temp) return null
        return Buffer.from([
            0xf0,
            0x26,
            course,
            this.optionValue(this.reported.soil, 'intensive', INTENSIVE_SOIL, DEFAULT_SOIL),
            spin,
            temp,
            this.optionValue(this.reported.rinse, 'extra_rinse', EXTRA_RINSE, DEFAULT_RINSE),
            0,
            0,
            0,
            0,
            (this.option('prewash') ? PREWASH : 0) | (this.option('steam') ? STEAM : 0),
            0x03 | (this.option('wrinkle_care') ? WRINKLE_CARE : 0),
            0,
            0,
            0,
            0,
            0,
        ])
    }
}

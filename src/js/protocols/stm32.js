/*
    STM32 F103 serial bus seems to properly initialize with quite a huge auto-baud range
    From 921600 down to 1200, i don't recommend getting any lower then that
    Official "specs" are from 115200 to 1200

    popular choices - 921600, 460800, 256000, 230400, 153600, 128000, 115200, 57600, 38400, 28800, 19200
*/
'use strict';

const STM32_protocol = function () {
    this.baud = null;
    this.options = {};
    this.callback = null;
    this.hex = null;
    this.verify_hex = [];

    this.receive_buffer = [];

    this.bytesToRead = 0;
    this.read_callback = null;

    this.upload_time_start = 0;
    this.upload_process_alive = false;

    this.msp_connector = new MSPConnectorImpl();

    this.status = {
        ACK:    0x79, // y
        NACK:   0x1F,
    };

    this.command = {
        get:                    0x00, // Gets the version and the allowed commands supported by the current version of the bootloader
        get_ver_r_protect_s:    0x01, // Gets the bootloader version and the Read Protection status of the Flash memory
        get_ID:                 0x02, // Gets the chip ID
        read_memory:            0x11, // Reads up to 256 bytes of memory starting from an address specified by the application
        go:                     0x21, // Jumps to user application code located in the internal Flash memory or in SRAM
        write_memory:           0x31, // Writes up to 256 bytes to the RAM or Flash memory starting from an address specified by the application
        erase:                  0x43, // Erases from one to all the Flash memory pages
        extended_erase:         0x44, // Erases from one to all the Flash memory pages using two byte addressing mode (v3.0+ usart).
        write_protect:          0x63, // Enables the write protection for some sectors
        write_unprotect:        0x73, // Disables the write protection for all Flash memory sectors
        readout_protect:        0x82, // Enables the read protection
        readout_unprotect:      0x92,  // Disables the read protection
    };

    // Erase (x043) and Extended Erase (0x44) are exclusive. A device may support either the Erase command or the Extended Erase command but not both.

    this.available_flash_size = 0;
    this.page_size = 0;
    this.useExtendedErase = false;
};

// no input parameters
STM32_protocol.prototype.connect = function (port, baud, hex, options, callback) {
    const self = this;
    self.hex = hex;
    self.port = port;
    self.baud = baud;
    self.callback = callback;

    // we will crunch the options here since doing it inside initialization routine would be too late
    self.options = {
        no_reboot:      false,
        reboot_baud:    false,
        erase_chip:     false,
    };

    if (options.no_reboot) {
        self.options.no_reboot = true;
    } else {
        self.options.reboot_baud = options.reboot_baud;
    }

    if (options.erase_chip) {
        self.options.erase_chip = true;
    }

    if (self.options.no_reboot) {
        serial.connect(port, {bitrate: self.baud, parityBit: 'even', stopBits: 'one'}, function (openInfo) {
            if (openInfo) {
                // we are connected, disabling connect button in the UI
                GUI.connect_lock = true;

                self.initialize();
            } else {
                GUI.log(i18n.getMessage('serialPortOpenFail'));
            }
        });
    } else {

        let rebootMode = 0; // FIRMWARE
        const startFlashing = () => {
            if (rebootMode === 0) {
                return;
            }

            // refresh device list
            PortHandler.check_usb_devices(function(dfu_available) {
                if (dfu_available) {
                    STM32DFU.connect(usbDevices, hex, options);
                } else {
                    serial.connect(self.port, {bitrate: self.baud, parityBit: 'even', stopBits: 'one'}, function (openInfo) {
                        if (openInfo) {
                            self.initialize();
                        } else {
                            GUI.connect_lock = false;
                            GUI.log(i18n.getMessage('serialPortOpenFail'));
                        }
                    });
                }
            });
        };

        const onDisconnect = disconnectionResult => {
            if (disconnectionResult) {
                // wait until board boots into bootloader mode
                // MacOs may need 5 seconds delay
                function waitForDfu() {
                    if (PortHandler.dfu_available) {
                        console.log(`DFU available after ${failedAttempts / 10} seconds`);
                        clearInterval(dfuWaitInterval);
                        startFlashing();
                    } else {
                        failedAttempts++;
                        if (failedAttempts > 100) {
                            clearInterval(dfuWaitInterval);
                            console.log(`failed to get DFU connection, gave up after 10 seconds`);
                            GUI.log(i18n.getMessage('serialPortOpenFail'));
                            GUI.connect_lock = false;
                        }
                    }
                }

                let failedAttempts = 0;
                const dfuWaitInterval = setInterval(waitForDfu, 100);
            } else {
                GUI.connect_lock = false;
            }
        };

        const legacyRebootAndFlash = function() {
            serial.connect(self.port, {bitrate: self.options.reboot_baud}, function (openInfo) {
                if (!openInfo) {
                    GUI.connect_lock = false;
                    GUI.log(i18n.getMessage('serialPortOpenFail'));
                    return;
                }

                console.log('Using legacy reboot method');

                console.log('Sending ascii "R" to reboot');
                const bufferOut = new ArrayBuffer(1);
                const bufferView = new Uint8Array(bufferOut);

                bufferView[0] = 0x52;

                serial.send(bufferOut, function () {
                    serial.disconnect(disconnectionResult => onDisconnect(disconnectionResult));
                });
            });
        };

        const onConnectHandler = function () {

            GUI.log(i18n.getMessage('apiVersionReceived', [FC.CONFIG.apiVersion]));

            if (semver.lt(FC.CONFIG.apiVersion, API_VERSION_1_42)) {
                self.msp_connector.disconnect(function (disconnectionResult) {

                    // need some time for the port to be closed, serial port does not open if tried immediately
                    setTimeout(legacyRebootAndFlash, 500);
                });
            } else {
                console.log('Looking for capabilities via MSP');

                MSP.send_message(MSPCodes.MSP_BOARD_INFO, false, false, () => {
                    if (bit_check(FC.CONFIG.targetCapabilities, FC.TARGET_CAPABILITIES_FLAGS.HAS_FLASH_BOOTLOADER)) {
                        // Board has flash bootloader
                        GUI.log(i18n.getMessage('deviceRebooting_flashBootloader'));
                        console.log('flash bootloader detected');
                        rebootMode = 4; // MSP_REBOOT_BOOTLOADER_FLASH
                    } else {
                        GUI.log(i18n.getMessage('deviceRebooting_romBootloader'));
                        console.log('no flash bootloader detected');
                        rebootMode = 1; // MSP_REBOOT_BOOTLOADER_ROM;
                    }

                    const selectedBoard = TABS.firmware_flasher.selectedBoard !== '0' ? TABS.firmware_flasher.selectedBoard : 'NONE';
                    const connectedBoard = FC.CONFIG.boardName ? FC.CONFIG.boardName : 'UNKNOWN';

                    function reboot() {
                        const buffer = [];
                        buffer.push8(rebootMode);
                        MSP.send_message(MSPCodes.MSP_SET_REBOOT, buffer, () => {

                            // if firmware doesn't flush MSP/serial send buffers and gracefully shutdown VCP connections we won't get a reply, so don't wait for it.

                            self.msp_connector.disconnect(disconnectionResult => onDisconnect(disconnectionResult));

                        }, () => console.log('Reboot request received by device'));
                    }

                    function onAbort() {
                        GUI.connect_lock = false;
                        rebootMode = 0;
                        console.log('User cancelled because selected target does not match verified board');
                        reboot();
                        TABS.firmware_flasher.refresh();
                    }

                    if (selectedBoard !== connectedBoard && !TABS.firmware_flasher.localFirmwareLoaded) {
                        TABS.firmware_flasher.showDialogVerifyBoard(selectedBoard, connectedBoard, onAbort, reboot);
                    } else {
                        reboot();
                    }
                });
            }
        };

        const onTimeoutHandler = function() {
            GUI.connect_lock = false;
            console.log('Looking for capabilities via MSP failed');

            TABS.firmware_flasher.flashingMessage(i18n.getMessage('stm32RebootingToBootloaderFailed'), TABS.firmware_flasher.FLASH_MESSAGE_TYPES.INVALID);
        };

        const onFailureHandler = function() {
            GUI.connect_lock = false;
            TABS.firmware_flasher.refresh();
        };

        GUI.connect_lock = true;
        TABS.firmware_flasher.flashingMessage(i18n.getMessage('stm32RebootingToBootloader'), TABS.firmware_flasher.FLASH_MESSAGE_TYPES.NEUTRAL);

        self.msp_connector.connect(self.port, self.options.reboot_baud, onConnectHandler, onTimeoutHandler, onFailureHandler);
    }
};

// initialize certain variables and start timers that oversee the communication
STM32_protocol.prototype.initialize = function () {
    const self = this;

    // reset and set some variables before we start
    self.receive_buffer = [];
    self.verify_hex = [];

    self.upload_time_start = new Date().getTime();
    self.upload_process_alive = false;

    // reset progress bar to initial state
    TABS.firmware_flasher.flashingMessage(null, TABS.firmware_flasher.FLASH_MESSAGE_TYPES.NEUTRAL)
                         .flashProgress(0);

    // lock some UI elements TODO needs rework
    $('select[name="release"]').prop('disabled', true);

    serial.onReceive.addListener(function (info) {
        self.read(info);
    });

    GUI.interval_add('STM32_timeout', function () {
        if (self.upload_process_alive) { // process is running
            self.upload_process_alive = false;
        } else {
            console.log('STM32 - timed out, programming failed ...');

            TABS.firmware_flasher.flashingMessage(i18n.getMessage('stm32TimedOut'), TABS.firmware_flasher.FLASH_MESSAGE_TYPES.INVALID);

            // protocol got stuck, clear timer and disconnect
            GUI.interval_remove('STM32_timeout');

            // exit
            self.upload_procedure(99);
        }
    }, 2000);

    self.upload_procedure(1);
};

// no input parameters
// this method should be executed every 1 ms via interval timer
STM32_protocol.prototype.read = function (readInfo) {
    // routine that fills the buffer
    const data = new Uint8Array(readInfo.data);

    for (const instance of data) {
        this.receive_buffer.push(instance);
    }

    // routine that fetches data from buffer if statement is true
    if (this.receive_buffer.length >= this.bytesToRead && this.bytesToRead != 0) {
        const fetched = this.receive_buffer.slice(0, this.bytesToRead); // bytes requested
        this.receive_buffer.splice(0, this.bytesToRead); // remove read bytes

        this.bytesToRead = 0; // reset trigger

        this.read_callback(fetched);
    }
};

// we should always try to consume all "proper" available data while using retrieve
STM32_protocol.prototype.retrieve = function (nBytes, callback) {
    if (this.receive_buffer.length >= nBytes) {
        // data that we need are there, process immediately
        const data = this.receive_buffer.slice(0, nBytes);
        this.receive_buffer.splice(0, nBytes); // remove read bytes

        callback(data);
    } else {
        // still waiting for data, add callback
        this.bytesToRead = nBytes;
        this.read_callback = callback;
    }
};

// bytes_to_send = array of bytes that will be send over serial
// bytesToRead = received bytes necessary to trigger read_callback
// callback = function that will be executed after received bytes = bytesToRead
STM32_protocol.prototype.send = function (bytes_to_send, bytesToRead, callback) {
    // flip flag
    this.upload_process_alive = true;

    const bufferOut = new ArrayBuffer(bytes_to_send.length);
    const bufferView = new Uint8Array(bufferOut);

    // set bytes_to_send values inside bufferView (alternative to for loop)
    bufferView.set(bytes_to_send);

    // update references
    this.bytesToRead = bytesToRead;
    this.read_callback = callback;

    // empty receive buffer before next command is out
    this.receive_buffer = [];

    // send over the actual data
    serial.send(bufferOut);
};

// val = single byte to be verified
// data = response of n bytes from mcu (array)
// result = true/false
STM32_protocol.prototype.verify_response = function (val, data) {

    if (val !== data[0]) {
        const message = `STM32 Communication failed, wrong response, expected: ${val} (0x${val.toString(16)}) received: ${data[0]} (0x${data[0].toString(16)})`;
        console.error(message);
        TABS.firmware_flasher.flashingMessage(i18n.getMessage('stm32WrongResponse',[val, val.toString(16), data[0], data[0].toString(16)]), TABS.firmware_flasher.FLASH_MESSAGE_TYPES.INVALID);

        // disconnect
        this.upload_procedure(99);

        return false;
    }

    return true;
};

// input = 16 bit value
// result = true/false
STM32_protocol.prototype.verify_chip_signature = function (signature) {
    switch (signature) {
        case 0x412: // not tested
            console.log('Chip recognized as F1 Low-density');
            break;
        case 0x410:
            console.log('Chip recognized as F1 Medium-density');
            this.available_flash_size = 131072;
            this.page_size = 1024;
            break;
        case 0x414:
            this.available_flash_size =  0x40000;
            this.page_size = 2048;
            console.log('Chip recognized as F1 High-density');
            break;
        case 0x418: // not tested
            console.log('Chip recognized as F1 Connectivity line');
            break;
        case 0x420:  // not tested
            console.log('Chip recognized as F1 Medium-density value line');
            break;
        case 0x428: // not tested
            console.log('Chip recognized as F1 High-density value line');
            break;
        case 0x430: // not tested
            console.log('Chip recognized as F1 XL-density value line');
            break;
        case 0x416: // not tested
            console.log('Chip recognized as L1 Medium-density ultralow power');
            break;
        case 0x436: // not tested
            console.log('Chip recognized as L1 High-density ultralow power');
            break;
        case 0x427: // not tested
            console.log('Chip recognized as L1 Medium-density plus ultralow power');
            break;
        case 0x411: // not tested
            console.log('Chip recognized as F2 STM32F2xxxx');
            break;
        case 0x440: // not tested
            console.log('Chip recognized as F0 STM32F051xx');
            break;
        case 0x444: // not tested
            console.log('Chip recognized as F0 STM32F050xx');
            break;
        case 0x413: // not tested
            console.log('Chip recognized as F4 STM32F40xxx/41xxx');
            break;
        case 0x419: // not tested
            console.log('Chip recognized as F4 STM32F427xx/437xx, STM32F429xx/439xx');
            break;
        case 0x432: // not tested
            console.log('Chip recognized as F3 STM32F37xxx, STM32F38xxx');
            break;
        case 0x422:
            console.log('Chip recognized as F3 STM32F30xxx, STM32F31xxx');
            this.available_flash_size =  0x40000;
            this.page_size = 2048;
            break;
    }

    if (this.available_flash_size > 0) {
        if (this.hex.bytes_total < this.available_flash_size) {
            return true;
        } else {
            console.log(`Supplied hex is bigger then flash available on the chip, HEX: ${this.hex.bytes_total} bytes, limit = ${this.available_flash_size} bytes`);
            return false;
        }
    }

    console.log(`Chip NOT recognized: ${signature}`);

    return false;
};

// firstArray = usually hex_to_flash array
// secondArray = usually verify_hex array
// result = true/false
STM32_protocol.prototype.verify_flash = function (firstArray, secondArray) {
    for (let i = 0; i < firstArray.length; i++) {
        if (firstArray[i] !== secondArray[i]) {
            console.log(`Verification failed on byte: ${i} expected: 0x${firstArray[i].toString(16)} received: 0x${secondArray[i].toString(16)}`);
            return false;
        }
    }

    console.log(`Verification successful, matching: ${firstArray.length} bytes`);

    return true;
};

// step = value depending on current state of upload_procedure
STM32_protocol.prototype.upload_procedure = function (step) {
    const self = this;

    switch (step) {
        case 1:
            // initialize serial interface on the MCU side, auto baud rate settings
            TABS.firmware_flasher.flashingMessage(i18n.getMessage('stm32ContactingBootloader'), TABS.firmware_flasher.FLASH_MESSAGE_TYPES.NEUTRAL);

            let sendCounter = 0;
            GUI.interval_add('stm32_initialize_mcu', function () { // 200 ms interval (just in case mcu was already initialized), we need to break the 2 bytes command requirement
                self.send([0x7F], 1, function (reply) {
                    if (reply[0] === 0x7F || reply[0] === self.status.ACK || reply[0] === self.status.NACK) {
                        GUI.interval_remove('stm32_initialize_mcu');
                        console.log('STM32 - Serial interface initialized on the MCU side');

                        // proceed to next step
                        self.upload_procedure(2);
                    } else {
                        TABS.firmware_flasher.flashingMessage(i18n.getMessage('stm32ContactingBootloaderFailed'), TABS.firmware_flasher.FLASH_MESSAGE_TYPES.INVALID);

                        GUI.interval_remove('stm32_initialize_mcu');

                        // disconnect
                        self.upload_procedure(99);
                    }
                });

                if (sendCounter++ > 3) {
                    // stop retrying, its too late to get any response from MCU
                    console.log('STM32 - no response from bootloader, disconnecting');

                    TABS.firmware_flasher.flashingMessage(i18n.getMessage('stm32ResponseBootloaderFailed'), TABS.firmware_flasher.FLASH_MESSAGE_TYPES.INVALID);

                    GUI.interval_remove('stm32_initialize_mcu');
                    GUI.interval_remove('STM32_timeout');

                    // exit
                    self.upload_procedure(99);
                }
            }, 250, true);

            break;
        case 2:
            // get version of the bootloader and supported commands
            self.send([self.command.get, 0xFF], 2, function (data) { // 0x00 ^ 0xFF
                if (self.verify_response(self.status.ACK, data)) {
                    self.retrieve(data[1] + 1 + 1, function (data) { // data[1] = number of bytes that will follow [– 1 except current and ACKs]
                        console.log(`STM32 - Bootloader version: ${(parseInt(data[0].toString(16)) / 10).toFixed(1)}`); // convert dec to hex, hex to dec and add floating point

                        self.useExtendedErase = (data[7] === self.command.extended_erase);

                        // proceed to next step
                        self.upload_procedure(3);
                    });
                }
            });

            break;
        case 3:
            // get ID (device signature)
            self.send([self.command.get_ID, 0xFD], 2, function (data) { // 0x01 ^ 0xFF
                if (self.verify_response(self.status.ACK, data)) {
                    self.retrieve(data[1] + 1 + 1, function (data) { // data[1] = number of bytes that will follow [– 1 (N = 1 for STM32), except for current byte and ACKs]
                        const signature = (data[0] << 8) | data[1];
                        console.log(`STM32 - Signature: 0x${signature.toString(16)}`); // signature in hex representation

                        if (self.verify_chip_signature(signature)) {
                            // proceed to next step
                            self.upload_procedure(4);
                        } else {
                            // disconnect
                            self.upload_procedure(99);
                        }
                    });
                }
            });

            break;
        case 4:
            // erase memory

            if (self.useExtendedErase) {
                if (self.options.erase_chip) {

                    const message = 'Executing global chip erase (via extended erase)';
                    console.log(message);
                    TABS.firmware_flasher.flashingMessage(i18n.getMessage('stm32GlobalEraseExtended'), TABS.firmware_flasher.FLASH_MESSAGE_TYPES.NEUTRAL);

                    self.send([self.command.extended_erase, 0xBB], 1, function (reply) {
                        if (self.verify_response(self.status.ACK, reply)) {
                            self.send( [0xFF, 0xFF, 0x00], 1, function (reply) {
                                if (self.verify_response(self.status.ACK, reply)) {
                                    console.log('Executing global chip extended erase: done');
                                    self.upload_procedure(5);
                                }
                            });
                        }
                    });

                } else {
                    const message = 'Executing local erase (via extended erase)';
                    console.log(message);
                    TABS.firmware_flasher.flashingMessage(i18n.getMessage('stm32LocalEraseExtended'), TABS.firmware_flasher.FLASH_MESSAGE_TYPES.NEUTRAL);

                    self.send([self.command.extended_erase, 0xBB], 1, function (reply) {
                        if (self.verify_response(self.status.ACK, reply)) {

                            // For reference: https://code.google.com/p/stm32flash/source/browse/stm32.c#723

                            const maxAddress = self.hex.data[self.hex.data.length - 1].address + self.hex.data[self.hex.data.length - 1].bytes - 0x8000000;
                            const erasePagesN = Math.ceil(maxAddress / self.page_size);
                            const buff = [];
                            let checksum = 0;

                            let pgByte;

                            pgByte = (erasePagesN - 1) >> 8;
                            buff.push(pgByte);
                            checksum ^= pgByte;
                            pgByte = (erasePagesN - 1) & 0xFF;
                            buff.push(pgByte);
                            checksum ^= pgByte;


                            for (let i = 0; i < erasePagesN; i++) {
                                pgByte = i >> 8;
                                buff.push(pgByte);
                                checksum ^= pgByte;
                                pgByte = i & 0xFF;
                                buff.push(pgByte);
                                checksum ^= pgByte;
                            }

                            buff.push(checksum);
                            console.log(`Erasing. pages: 0x00 - 0x${erasePagesN.toString(16)}, checksum: 0x${checksum.toString(16)}`);

                            self.send(buff, 1, function (_reply) {
                                if (self.verify_response(self.status.ACK, _reply)) {
                                    console.log('Erasing: done');
                                    // proceed to next step
                                    self.upload_procedure(5);
                                }
                            });
                        }
                    });


                }
                break;
            }

            if (self.options.erase_chip) {
                const message = 'Executing global chip erase' ;
                console.log(message);
                TABS.firmware_flasher.flashingMessage(i18n.getMessage('stm32GlobalErase'), TABS.firmware_flasher.FLASH_MESSAGE_TYPES.NEUTRAL);

                self.send([self.command.erase, 0xBC], 1, function (reply) { // 0x43 ^ 0xFF
                    if (self.verify_response(self.status.ACK, reply)) {
                        self.send([0xFF, 0x00], 1, function (reply) {
                            if (self.verify_response(self.status.ACK, reply)) {
                                console.log('Erasing: done');
                                // proceed to next step
                                self.upload_procedure(5);
                            }
                        });
                    }
                });
            } else {
                const message = 'Executing local erase';
                console.log(message);
                TABS.firmware_flasher.flashingMessage(i18n.getMessage('stm32LocalErase'), TABS.firmware_flasher.FLASH_MESSAGE_TYPES.NEUTRAL);

                self.send([self.command.erase, 0xBC], 1, function (reply) { // 0x43 ^ 0xFF
                    if (self.verify_response(self.status.ACK, reply)) {
                        // the bootloader receives one byte that contains N, the number of pages to be erased – 1
                        const maxAddress = self.hex.data[self.hex.data.length - 1].address + self.hex.data[self.hex.data.length - 1].bytes - 0x8000000;
                        const erasePagesN = Math.ceil(maxAddress / self.page_size);
                        const buff = [];
                        let checksum = erasePagesN - 1;

                        buff.push(erasePagesN - 1);

                        for (let ii = 0; ii < erasePagesN; ii++) {
                            buff.push(ii);
                            checksum ^= ii;
                        }

                        buff.push(checksum);

                        self.send(buff, 1, function (reply) {
                            if (self.verify_response(self.status.ACK, reply)) {
                                console.log('Erasing: done');
                                // proceed to next step
                                self.upload_procedure(5);
                            }
                        });
                    }
                });
            }

            break;
        case 5:
            // upload
            console.log('Writing data ...');
            TABS.firmware_flasher.flashingMessage(i18n.getMessage('stm32Flashing'), TABS.firmware_flasher.FLASH_MESSAGE_TYPES.NEUTRAL);

            let blocks = self.hex.data.length - 1,
                flashing_block = 0,
                address = self.hex.data[flashing_block].address,
                bytes_flashed = 0,
                bytes_flashed_total = 0; // used for progress bar

            const write = function () {
                if (bytes_flashed < self.hex.data[flashing_block].bytes) {
                    const bytesToWrite = ((bytes_flashed + 256) <= self.hex.data[flashing_block].bytes) ? 256 : (self.hex.data[flashing_block].bytes - bytes_flashed);

                    // console.log('STM32 - Writing to: 0x' + address.toString(16) + ', ' + bytesToWrite + ' bytes');

                    self.send([self.command.write_memory, 0xCE], 1, function (reply) { // 0x31 ^ 0xFF
                        if (self.verify_response(self.status.ACK, reply)) {
                            // address needs to be transmitted as 32 bit integer, we need to bit shift each byte out and then calculate address checksum
                            const addressArray = [(address >> 24), (address >> 16), (address >> 8), address];
                            const addressChecksum = addressArray[0] ^ addressArray[1] ^ addressArray[2] ^ addressArray[3];
                            // write start address + checksum
                            self.send([addressArray[0], addressArray[1], addressArray[2], addressArray[3], addressChecksum], 1, function (_reply) {
                                if (self.verify_response(self.status.ACK, _reply)) {
                                    const arrayOut = Array.from(bytesToWrite + 2); // 2 byte overhead [N, ...., checksum]
                                    arrayOut[0] = bytesToWrite - 1; // number of bytes to be written (to write 128 bytes, N must be 127, to write 256 bytes, N must be 255)

                                    let checksum = arrayOut[0];
                                    for (let ii = 0; ii < bytesToWrite; ii++) {
                                        arrayOut[ii + 1] = self.hex.data[flashing_block].data[bytes_flashed]; // + 1 because of the first byte offset
                                        checksum ^= self.hex.data[flashing_block].data[bytes_flashed];

                                        bytes_flashed++;
                                    }
                                    arrayOut[arrayOut.length - 1] = checksum; // checksum (last byte in the arrayOut array)

                                    address += bytesToWrite;
                                    bytes_flashed_total += bytesToWrite;

                                    self.send(arrayOut, 1, function (response) {
                                        if (self.verify_response(self.status.ACK, response)) {
                                            // flash another page
                                            write();
                                        }
                                    });

                                    // update progress bar
                                    TABS.firmware_flasher.flashProgress(Math.round(bytes_flashed_total / (self.hex.bytes_total * 2) * 100));
                                }
                            });
                        }
                    });
                } else {
                    // move to another block
                    if (flashing_block < blocks) {
                        flashing_block++;

                        address = self.hex.data[flashing_block].address;
                        bytes_flashed = 0;

                        write();
                    } else {
                        // all blocks flashed
                        console.log('Writing: done');

                        // proceed to next step
                        self.upload_procedure(6);
                    }
                }
            };

            // start writing
            write();

            break;
        case 6:
            // verify
            console.log('Verifying data ...');
            TABS.firmware_flasher.flashingMessage(i18n.getMessage('stm32Verifying'), TABS.firmware_flasher.FLASH_MESSAGE_TYPES.NEUTRAL);

            blocks = self.hex.data.length - 1;
            let readingBlock = 0;
            address = self.hex.data[readingBlock].address;
            let bytesVerified = 0;
            let bytesVerifiedTotal = 0; // used for progress bar

            // initialize arrays
            for (let i = 0; i <= blocks; i++) {
                self.verify_hex.push([]);
            }

            const reading = function () {
                if (bytesVerified < self.hex.data[readingBlock].bytes) {
                    const bytesToRead = ((bytesVerified + 256) <= self.hex.data[readingBlock].bytes) ? 256 : (self.hex.data[readingBlock].bytes - bytesVerified);

                    // console.log('STM32 - Reading from: 0x' + address.toString(16) + ', ' + bytesToRead + ' bytes');

                    self.send([self.command.read_memory, 0xEE], 1, function (reply) { // 0x11 ^ 0xFF
                        if (self.verify_response(self.status.ACK, reply)) {
                            const addressArray = [(address >> 24), (address >> 16), (address >> 8), address];
                            const addressChecksum = addressArray[0] ^ addressArray[1] ^ addressArray[2] ^ addressArray[3];

                            self.send([addressArray[0], addressArray[1], addressArray[2], addressArray[3], addressChecksum], 1, function (_reply) { // read start address + checksum
                                if (self.verify_response(self.status.ACK, _reply)) {
                                    const bytesToReadN = bytesToRead - 1;
                                    // bytes to be read + checksum XOR(complement of bytesToReadN)
                                    self.send([bytesToReadN, (~bytesToReadN) & 0xFF], 1, function (response) {
                                        if (self.verify_response(self.status.ACK, response)) {
                                            self.retrieve(bytesToRead, function (data) {
                                                for (const instance of data) {
                                                    self.verify_hex[readingBlock].push(instance);
                                                }

                                                address += bytesToRead;
                                                bytesVerified += bytesToRead;
                                                bytesVerifiedTotal += bytesToRead;

                                                // verify another page
                                                reading();
                                            });
                                        }
                                    });

                                    // update progress bar
                                    TABS.firmware_flasher.flashProgress(Math.round((self.hex.bytes_total + bytesVerifiedTotal) / (self.hex.bytes_total * 2) * 100));
                                }
                            });
                        }
                    });
                } else {
                    // move to another block
                    if (readingBlock < blocks) {
                        readingBlock++;

                        address = self.hex.data[readingBlock].address;
                        bytesVerified = 0;

                        reading();
                    } else {
                        // all blocks read, verify

                        let verify = true;
                        for (let i = 0; i <= blocks; i++) {
                            verify = self.verify_flash(self.hex.data[i].data, self.verify_hex[i]);

                            if (!verify) break;
                        }

                        if (verify) {
                            console.log('Programming: SUCCESSFUL');
                            // update progress bar
                            TABS.firmware_flasher.flashingMessage(i18n.getMessage('stm32ProgrammingSuccessful'), TABS.firmware_flasher.FLASH_MESSAGE_TYPES.VALID);

                            // proceed to next step
                            self.upload_procedure(7);
                        } else {
                            console.log('Programming: FAILED');
                            // update progress bar
                            TABS.firmware_flasher.flashingMessage(i18n.getMessage('stm32ProgrammingFailed'), TABS.firmware_flasher.FLASH_MESSAGE_TYPES.INVALID);

                            // disconnect
                            self.upload_procedure(99);
                        }
                    }
                }
            };

            // start reading
            reading();

            break;
        case 7:
            // go
            // memory address = 4 bytes, 1st high byte, 4th low byte, 5th byte = checksum XOR(byte 1, byte 2, byte 3, byte 4)
            console.log('Sending GO command: 0x8000000');

            self.send([self.command.go, 0xDE], 1, function (reply) { // 0x21 ^ 0xFF
                if (self.verify_response(self.status.ACK, reply)) {
                    const gtAddress = 0x8000000;
                    address = [(gtAddress >> 24), (gtAddress >> 16), (gtAddress >> 8), gtAddress];
                    const addressChecksum = address[0] ^ address[1] ^ address[2] ^ address[3];

                    self.send([address[0], address[1], address[2], address[3], addressChecksum], 1, function (response) {
                        if (self.verify_response(self.status.ACK, response)) {
                            // disconnect
                            self.upload_procedure(99);
                        }
                    });
                }
            });

            break;
        case 99:
            // disconnect
            GUI.interval_remove('STM32_timeout'); // stop STM32 timeout timer (everything is finished now)

            // close connection
            if (serial.connectionId) {
                serial.disconnect(self.cleanup);
            } else {
                self.cleanup();
            }

            break;
    }
};

STM32_protocol.prototype.cleanup = function () {
    PortUsage.reset();

    // unlocking connect button
    GUI.connect_lock = false;

    // unlock some UI elements TODO needs rework
    $('select[name="release"]').prop('disabled', false);

    // handle timing
    const timeSpent = new Date().getTime() - self.upload_time_start;

    console.log(`Script finished after: ${(timeSpent / 1000)} seconds`);

    if (self.callback) {
        self.callback();
    }
};

// initialize object
const STM32 = new STM32_protocol();

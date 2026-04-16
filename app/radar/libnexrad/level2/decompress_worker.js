const compressjs = require('../../../../lib/compressjs/main');
const pako = require('pako');
const RandomAccessFile = require('../buffer_tools/RandomAccessFile');
const BufferPack = require('bufferpack');
const level2_constants = require('./level2_constants');

module.exports = function (self) {

    function _arraysEqual(arr1, arr2) {
        if (arr1.length !== arr2.length) return false;
        for (var i = 0; i < arr1.length; i++) {
            if (arr1[i] !== arr2[i]) return false;
        }
        return true;
    }

    function _bufferToString(buffer) {
        return new TextDecoder('UTF-8').decode(buffer);
    }

    function _structure_size(structure) {
        var format = '>' + structure.map(i => i[1]).join('');
        return BufferPack.calcLength(format);
    }

    function _unpack_from_buf(buf, pos, structure) {
        var size = _structure_size(structure);
        return _unpack_structure(buf.slice(pos, pos + size), structure);
    }

    function _unpack_structure(string, structure) {
        var fmt = '>' + structure.map(i => i[1]).join('');
        var lst = BufferPack.unpack(fmt, string);
        return structure.reduce((acc, curr, index) => {
            acc[curr[0]] = lst[index];
            return acc;
        }, {});
    }

    function swap16(buffer) {
        const length = buffer.length / 2;
        var data = new Uint16Array(length);
        for (let i = 0; i < length; i++) {
            data[i] = (buffer[i * 2] << 8) | buffer[i * 2 + 1];
        }
        return data;
    }

    function _get_msg31_data_block(buf, ptr) {
        var block_name = _bufferToString(buf.slice(ptr + 1, ptr + 4)).trim();
        block_name = block_name.replace(/[^a-z0-9 ,.?!]/ig, '');

        var dic;
        if (block_name == 'VOL') {
            dic = _unpack_from_buf(buf, ptr, level2_constants.VOLUME_DATA_BLOCK);
        } else if (block_name == 'ELV') {
            dic = _unpack_from_buf(buf, ptr, level2_constants.ELEVATION_DATA_BLOCK);
        } else if (block_name == 'RAD') {
            dic = _unpack_from_buf(buf, ptr, level2_constants.RADIAL_DATA_BLOCK);
        } else if (['REF', 'VEL', 'SW', 'ZDR', 'PHI', 'RHO', 'CFP'].includes(block_name)) {
            dic = _unpack_from_buf(buf, ptr, level2_constants.GENERIC_DATA_BLOCK);
            var ngates = dic['ngates'];
            var ptr2 = ptr + _structure_size(level2_constants.GENERIC_DATA_BLOCK);
            var data;
            if (dic['word_size'] == 16) {
                data = swap16(buf.slice(ptr2, ptr2 + ngates * 2));
            } else if (dic['word_size'] == 8) {
                data = Array.from(buf.slice(ptr2, ptr2 + ngates));
            }
            dic['data'] = data;
        } else {
            dic = {};
        }
        return [block_name, dic];
    }

    function _get_msg31_from_buf(buf, pos, dic) {
        var msg_size = dic['header']['size'] * 2 - 4;
        var msg_header_size = _structure_size(level2_constants.MSG_HEADER);
        var new_pos = pos + msg_header_size + msg_size;
        var mbuf = buf.slice(pos + msg_header_size, new_pos);
        var msg_31_header = _unpack_from_buf(mbuf, 0, level2_constants.MSG_31);

        var block_pointers = Object.values(msg_31_header).filter((v, k) => Object.keys(msg_31_header)[k].startsWith('block_pointer') && v > 0);
        for (var i in block_pointers) {
            var [block_name, block_dic] = _get_msg31_data_block(mbuf, block_pointers[i]);
            dic[block_name] = block_dic;
        }

        dic['msg_header'] = msg_31_header;
        return new_pos;
    }

    function _get_msg1_from_buf(buf, pos, dic) {
        var msg_header_size = _structure_size(level2_constants.MSG_HEADER);
        var msg1_header = _unpack_from_buf(buf, pos + msg_header_size, level2_constants.MSG_1);
        dic['msg_header'] = msg1_header;

        var sur_nbins = parseInt(msg1_header['sur_nbins']);
        var doppler_nbins = parseInt(msg1_header['doppler_nbins']);
        var sur_step = parseInt(msg1_header['sur_range_step']);
        var doppler_step = parseInt(msg1_header['doppler_range_step']);
        var sur_first = parseInt(msg1_header['sur_range_first']);
        var doppler_first = parseInt(msg1_header['doppler_range_first']);
        if (doppler_first > 2**15) doppler_first = doppler_first - 2**16;

        function _check_empty(moment, nbins) {
            return nbins == 0 ? `${moment}_empty` : moment;
        }

        if (msg1_header['sur_pointer']) {
            var offset = pos + msg_header_size + msg1_header['sur_pointer'];
            dic[_check_empty('REF', sur_nbins)] = {
                'ngates': sur_nbins, 'gate_spacing': sur_step, 'first_gate': sur_first,
                'data': Uint8Array.from(buf.slice(offset, offset + sur_nbins)),
                'scale': 2.0, 'offset': 66.0,
            };
        }
        if (msg1_header['vel_pointer']) {
            var offset = pos + msg_header_size + msg1_header['vel_pointer'];
            var velDic = {
                'ngates': doppler_nbins, 'gate_spacing': doppler_step, 'first_gate': doppler_first,
                'data': Uint8Array.from(buf.slice(offset, offset + doppler_nbins)),
                'scale': 2.0, 'offset': 129.0,
            };
            if (msg1_header['doppler_resolution'] == 4) velDic['scale'] = 1.0;
            dic[_check_empty('VEL', doppler_nbins)] = velDic;
        }
        if (msg1_header['width_pointer']) {
            var offset = pos + msg_header_size + msg1_header['width_pointer'];
            dic[_check_empty('SW', doppler_nbins)] = {
                'ngates': doppler_nbins, 'gate_spacing': doppler_step, 'first_gate': doppler_first,
                'data': Uint8Array.from(buf.slice(offset, offset + doppler_nbins)),
                'scale': 2.0, 'offset': 129.0,
            };
        }
        return pos + level2_constants.RECORD_SIZE;
    }

    function _get_msg29_from_buf(pos, dic) {
        var msg_size = dic['header']['size'];
        if (msg_size == 65535) msg_size = (dic['header']['segments'] << 16) | dic['header']['seg_num'];
        return pos + _structure_size(level2_constants.MSG_HEADER) + msg_size;
    }

    function _get_msg5_from_buf(buf, pos, dic) {
        var msg_header_size = _structure_size(level2_constants.MSG_HEADER);
        var msg5_header_size = _structure_size(level2_constants.MSG_5);
        var msg5_elev_size = _structure_size(level2_constants.MSG_5_ELEV);

        dic['msg5_header'] = _unpack_from_buf(buf, pos + msg_header_size, level2_constants.MSG_5);
        dic['cut_parameters'] = [];
        for (var i = 0; i < dic['msg5_header']['num_cuts']; i++) {
            dic['cut_parameters'].push(_unpack_from_buf(buf, pos + msg_header_size + msg5_header_size + msg5_elev_size * i, level2_constants.MSG_5_ELEV));
        }
        return pos + level2_constants.RECORD_SIZE;
    }

    function _get_record_from_buf(buf, pos) {
        var dic = {'header': _unpack_from_buf(buf, pos, level2_constants.MSG_HEADER)};
        var msg_type = dic['header']['type'];
        var new_pos;
        if (msg_type == 31) {
            new_pos = _get_msg31_from_buf(buf, pos, dic);
        } else if (msg_type == 5) {
            try { new_pos = _get_msg5_from_buf(buf, pos, dic); }
            catch (e) { new_pos = pos + level2_constants.RECORD_SIZE; }
        } else if (msg_type == 29) {
            new_pos = _get_msg29_from_buf(pos, dic);
        } else if (msg_type == 1) {
            new_pos = _get_msg1_from_buf(buf, pos, dic);
        } else {
            new_pos = pos + level2_constants.RECORD_SIZE;
        }
        return [new_pos, dic];
    }

    // --- BZ2 decompression ---

    class RadarDecompressor {
        constructor() { this.unused_data; }
        _decompress_chunk(chunk) { return compressjs.Bzip2.decompressFile(chunk); }
        decompress(data, totalLength) {
            var rafData = new RandomAccessFile(data);
            var blockSize = Math.abs(rafData.readInt());
            this._block_percent = blockSize / totalLength;
            data = data.slice(level2_constants.CONTROL_WORD_SIZE, data.length);
            var uncompressed = this._decompress_chunk(data);
            this.unused_data = data.slice(blockSize, data.length);
            if (blockSize > data.length) this.unused_data = new Buffer.alloc(0);
            return uncompressed;
        }
    }

    function _decompress_records(file_handler, totalLength) {
        file_handler.seek(0);
        var cbuf = file_handler.peek();
        var decompressor = new RadarDecompressor();
        var skip = _structure_size(level2_constants.VOLUME_HEADER);
        var buf = [decompressor.decompress(cbuf.slice(skip, cbuf.length), totalLength)];
        var seen_length = decompressor._block_percent;

        while (decompressor.unused_data.length) {
            cbuf = decompressor.unused_data;
            decompressor = new RadarDecompressor();
            buf.push(decompressor.decompress(cbuf, totalLength));
            seen_length += decompressor._block_percent;
            var percent = parseFloat((seen_length * 100).toFixed(1));
            if (percent > 100) percent = 100;
            self.postMessage({ 'message': 'progress', 'data': percent });
        }

        var finalBuffer = Buffer.concat(buf);
        return finalBuffer.slice(level2_constants.COMPRESSION_RECORD_SIZE, finalBuffer.length);
    }

    // --- Main message handler ---

    self.addEventListener('message', function (ev) {
        var fileBuffer = ev.data;
        var fh = new RandomAccessFile(fileBuffer);

        // Gzip decompression
        var magic = Array.from(fh.peek(3));
        if (_arraysEqual(magic, [31, 139, 8])) {
            fh = new RandomAccessFile(Buffer.from(pako.inflate(fh.buffer)));
        }

        // Read volume header
        var vol_header_size = _structure_size(level2_constants.VOLUME_HEADER);
        var volume_header = _unpack_structure(fh.read(vol_header_size), level2_constants.VOLUME_HEADER);
        var compression_record = fh.read(level2_constants.COMPRESSION_RECORD_SIZE);
        var compression_or_ctm_info = compression_record.slice(
            level2_constants.CONTROL_WORD_SIZE,
            level2_constants.CONTROL_WORD_SIZE + 2
        );

        // Decompress BZ2 or read uncompressed
        var buf;
        if (_bufferToString(compression_or_ctm_info) == 'BZ') {
            buf = _decompress_records(fh, fileBuffer.length || fileBuffer.byteLength);
        } else {
            buf = fh.read();
        }

        // Parse all records
        var records = [];
        var pos = 0;
        while (pos < buf.length) {
            var record = _get_record_from_buf(buf, pos);
            pos = record[0];
            records.push(record[1]);
        }

        self.postMessage({
            'message': 'finish',
            'data': { volume_header: volume_header, records: records }
        });
    });
};

import { EVENTS, sniffer, MediaSegmentList, Buffer } from 'xgplayer-utils';
import Fmp4 from './fmp4';

var REMUX_EVENTS = EVENTS.REMUX_EVENTS;

var Mp4Remuxer = function () {
  function Mp4Remuxer() {
    var curTime = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : 0;
    babelHelpers.classCallCheck(this, Mp4Remuxer);

    this._dtsBase = curTime * 1000;
    this._isDtsBaseInited = false;
    this._videoSegmentList = new MediaSegmentList('video');
    this._audioSegmentList = new MediaSegmentList('audio');
    var browser = sniffer.browser;

    this._fillSilenceFrame = browser === 'ie';

    this.isFirstVideo = true;
    this.isFirstAudio = true;

    this.videoAllDuration = 0;
    this.audioAllDuration = 0;
  }

  babelHelpers.createClass(Mp4Remuxer, [{
    key: 'init',
    value: function init() {
      this.on(REMUX_EVENTS.REMUX_MEDIA, this.remux.bind(this));
      this.on(REMUX_EVENTS.REMUX_METADATA, this.onMetaDataReady.bind(this));
      this.on(REMUX_EVENTS.DETECT_CHANGE_STREAM, this.resetDtsBase.bind(this));
    }
  }, {
    key: 'destroy',
    value: function destroy() {
      this._dtsBase = -1;
      this._dtsBaseInited = false;
      this._videoSegmentList.clear();
      this._audioSegmentList.clear();
      this._videoSegmentList = null;
      this._audioSegmentList = null;
    }
  }, {
    key: 'remux',
    value: function remux() {
      var _context$getInstance = this._context.getInstance('TRACKS'),
          audioTrack = _context$getInstance.audioTrack,
          videoTrack = _context$getInstance.videoTrack;

      !this._isDtsBaseInited && this.calcDtsBase(audioTrack, videoTrack);

      this._remuxVideo(videoTrack);
      this._remuxAudio(audioTrack);
    }
  }, {
    key: 'resetDtsBase',
    value: function resetDtsBase() {
      // for hls 中途切换 meta后seek
      this._dtsBase = 0;
      this._dtsBaseInited = false;
    }
  }, {
    key: 'seek',
    value: function seek() {
      this._videoSegmentList.clear();
      this._audioSegmentList.clear();
    }
  }, {
    key: 'onMetaDataReady',
    value: function onMetaDataReady(type) {
      var track = void 0;

      if (type === 'audio') {
        var _context$getInstance2 = this._context.getInstance('TRACKS'),
            audioTrack = _context$getInstance2.audioTrack;

        track = audioTrack;
      } else {
        var _context$getInstance3 = this._context.getInstance('TRACKS'),
            videoTrack = _context$getInstance3.videoTrack;

        track = videoTrack;
      }

      var presourcebuffer = this._context.getInstance('PRE_SOURCE_BUFFER');
      var source = presourcebuffer.getSource(type);
      if (!source) {
        source = presourcebuffer.createSource(type);
      }

      source.mimetype = track.meta.codec;
      source.init = this.remuxInitSegment(type, track.meta);
      // source.inited = false;

      // this.resetDtsBase()
      this.emit(REMUX_EVENTS.INIT_SEGMENT, type);
    }
  }, {
    key: 'remuxInitSegment',
    value: function remuxInitSegment(type, meta) {
      var initSegment = new Buffer();
      var ftyp = Fmp4.ftyp();
      var moov = Fmp4.moov({ type: type, meta: meta });

      initSegment.write(ftyp, moov);
      return initSegment;
    }
  }, {
    key: 'calcDtsBase',
    value: function calcDtsBase(audioTrack, videoTrack) {
      if (!audioTrack && videoTrack.samples.length) {
        return videoTrack.samples[0].dts;
      }

      if (!audioTrack.samples.length && !videoTrack.samples.length) {
        return;
      }

      var audioBase = Infinity;
      var videoBase = Infinity;

      if (audioTrack.samples && audioTrack.samples.length) {
        audioBase = audioTrack.samples[0].dts;
      }
      if (videoTrack.samples && videoTrack.samples.length) {
        videoBase = videoTrack.samples[0].dts;
      }

      this._dtsBase = Math.min(audioBase, videoBase) - this._dtsBase; // 兼容播放器切换清晰度
      this._isDtsBaseInited = true;
    }
  }, {
    key: '_remuxVideo',
    value: function _remuxVideo(videoTrack) {
      var track = videoTrack || {};

      if (!videoTrack.samples || !videoTrack.samples.length) {
        return;
      }

      var samples = track.samples;

      var firstDts = -1;

      var initSegment = null;
      var mp4Samples = [];
      var mdatBox = {
        samples: []
      };

      var maxLoop = 10000;
      while (samples.length && maxLoop-- > 0) {
        // console.log('mark2')
        var avcSample = samples.shift();

        var isKeyframe = avcSample.isKeyframe,
            options = avcSample.options;

        if (!this.isFirstVideo && options && options.meta) {
          initSegment = this.remuxInitSegment('video', options.meta);
          options.meta = null;
          samples.unshift(avcSample);
          if (!options.isContinue) {
            this.resetDtsBase();
          }
          break;
        }

        var dts = avcSample.dts - this._dtsBase;

        if (firstDts === -1) {
          firstDts = dts;
        }

        var cts = void 0;
        var pts = void 0;
        if (avcSample.pts !== undefined) {
          pts = avcSample.pts - this._dtsBase;
          cts = pts - dts;
        }
        if (avcSample.cts !== undefined) {
          pts = avcSample.cts + dts;
          cts = avcSample.cts;
        }

        var mdatSample = {
          buffer: [],
          size: 0
        };
        mdatBox.samples.push(mdatSample);
        mdatSample.buffer.push(avcSample.data);
        mdatSample.size += avcSample.data.byteLength;

        var sampleDuration = 0;
        if (avcSample.duration) {
          sampleDuration = avcSample.duration;
        } else if (samples.length >= 1) {
          var nextDts = samples[0].dts - this._dtsBase;
          sampleDuration = nextDts - dts;
        } else {
          if (mp4Samples.length >= 1) {
            // lastest sample, use second last duration
            sampleDuration = mp4Samples[mp4Samples.length - 1].duration;
          } else {
            // the only one sample, use reference duration
            sampleDuration = this.videoMeta.refSampleDuration;
          }
        }
        this.videoAllDuration += sampleDuration;
        // console.log(`video dts ${dts}`, `pts ${pts}`, isKeyframe, `duration ${sampleDuration}`)
        if (sampleDuration >= 0) {
          mp4Samples.push({
            dts: dts,
            cts: cts,
            pts: pts,
            data: avcSample.data,
            size: avcSample.data.byteLength,
            isKeyframe: isKeyframe,
            duration: sampleDuration,
            flags: {
              isLeading: 0,
              dependsOn: isKeyframe ? 2 : 1,
              isDependedOn: isKeyframe ? 1 : 0,
              hasRedundancy: 0,
              isNonSync: isKeyframe ? 0 : 1
            },
            originDts: dts,
            type: 'video'
          });
        }

        if (isKeyframe) {
          this.emit(REMUX_EVENTS.RANDOM_ACCESS_POINT, pts);
        }
      }

      var moofMdat = new Buffer();
      if (mp4Samples.length) {
        var moof = Fmp4.moof({
          id: track.meta.id,
          time: firstDts,
          samples: mp4Samples
        });
        var mdat = Fmp4.mdat(mdatBox);
        moofMdat.write(moof, mdat);

        this.writeToSource('video', moofMdat);
      }

      if (initSegment) {
        this.writeToSource('video', initSegment);

        if (samples.length) {
          // second part of stream change
          track.samples = samples;
          return this._remuxVideo(track);
        }
      }

      this.isFirstVideo = false;
      this.emit(REMUX_EVENTS.MEDIA_SEGMENT, 'video');

      track.samples = [];
      track.length = 0;
    }
  }, {
    key: '_remuxAudio',
    value: function _remuxAudio(track) {
      var _ref = track || {},
          samples = _ref.samples;

      var firstDts = -1;
      var mp4Samples = [];

      var initSegment = null;
      var mdatBox = {
        samples: []
      };
      if (!samples || !samples.length) {
        return;
      }

      var maxLoop = 10000;
      var isFirstDtsInited = false;
      while (samples.length && maxLoop-- > 0) {
        // console.log('mark3')
        var sample = samples.shift();
        var data = sample.data,
            options = sample.options;

        if (!this.isFirstAudio && options && options.meta) {
          initSegment = this.remuxInitSegment('audio', options.meta);
          options.meta = null;
          samples.unshift(sample);
          if (!options.isContinue) {
            this.resetDtsBase();
          }
          break;
        }

        var dts = sample.dts - this._dtsBase;
        var originDts = dts;
        if (!isFirstDtsInited) {
          firstDts = dts;
          isFirstDtsInited = true;
        }

        var sampleDuration = 0;
        if (sample.duration) {
          sampleDuration = sample.duration;
        } else if (this.audioMeta.refSampleDurationFixed) {
          sampleDuration = this.audioMeta.refSampleDurationFixed;
        } else if (samples.length >= 1) {
          var nextDts = samples[0].dts - this._dtsBase;
          sampleDuration = nextDts - dts;
        } else {
          if (mp4Samples.length >= 1) {
            // use second last sample duration
            sampleDuration = mp4Samples[mp4Samples.length - 1].duration;
          } else {
            // the only one sample, use reference sample duration
            sampleDuration = this.audioMeta.refSampleDuration;
          }
        }

        // console.log(`audio dts ${dts}`, `pts ${dts}`, `duration ${sampleDuration}`)
        this.audioAllDuration += sampleDuration;
        var mp4Sample = {
          dts: dts,
          pts: dts,
          cts: 0,
          size: data.byteLength,
          duration: sample.duration ? sample.duration : sampleDuration,
          flags: {
            isLeading: 0,
            dependsOn: 2,
            isDependedOn: 1,
            hasRedundancy: 0,
            isNonSync: 0
          },
          isKeyframe: true,
          originDts: originDts,
          type: 'audio'
        };

        var mdatSample = {
          buffer: [],
          size: 0
        };
        mdatSample.buffer.push(data);
        mdatSample.size += data.byteLength;

        mdatBox.samples.push(mdatSample);
        if (sampleDuration >= 0) {
          mp4Samples.push(mp4Sample);
        }
      }

      var moofMdat = new Buffer();

      if (mp4Samples.length) {
        var moof = Fmp4.moof({
          id: track.meta.id,
          time: firstDts,
          samples: mp4Samples
        });
        var mdat = Fmp4.mdat(mdatBox);
        moofMdat.write(moof, mdat);

        this.writeToSource('audio', moofMdat);
      }

      if (initSegment) {
        this.writeToSource('audio', initSegment);
        if (samples.length) {
          // second part of stream change
          track.samples = samples;
          return this._remuxAudio(track);
        }
      }

      this.isFirstAudio = false;
      this.emit(REMUX_EVENTS.MEDIA_SEGMENT, 'audio', moofMdat);

      track.samples = [];
      track.length = 0;
    }
  }, {
    key: 'writeToSource',
    value: function writeToSource(type, buffer) {
      var presourcebuffer = this._context.getInstance('PRE_SOURCE_BUFFER');
      var source = presourcebuffer.getSource(type);
      if (!source) {
        source = presourcebuffer.createSource(type);
      }

      source.data.push(buffer);
    }
  }, {
    key: 'initSilentAudio',
    value: function initSilentAudio(dts, duration) {
      var unit = Mp4Remuxer.getSilentFrame(this._audioMeta.channelCount);
      return {
        dts: dts,
        pts: dts,
        cts: 0,
        duration: duration,
        unit: unit,
        size: unit.byteLength,
        originDts: dts,
        type: 'video'
      };
    }
  }, {
    key: 'destroy',
    value: function destroy() {
      this._player = null;
    }
  }, {
    key: 'videoMeta',
    get: function get() {
      return this._context.getInstance('TRACKS').videoTrack.meta;
    }
  }, {
    key: 'audioMeta',
    get: function get() {
      return this._context.getInstance('TRACKS').audioTrack.meta;
    }
  }], [{
    key: 'getSilentFrame',
    value: function getSilentFrame(channelCount) {
      if (channelCount === 1) {
        return new Uint8Array([0x00, 0xc8, 0x00, 0x80, 0x23, 0x80]);
      } else if (channelCount === 2) {
        return new Uint8Array([0x21, 0x00, 0x49, 0x90, 0x02, 0x19, 0x00, 0x23, 0x80]);
      } else if (channelCount === 3) {
        return new Uint8Array([0x00, 0xc8, 0x00, 0x80, 0x20, 0x84, 0x01, 0x26, 0x40, 0x08, 0x64, 0x00, 0x8e]);
      } else if (channelCount === 4) {
        return new Uint8Array([0x00, 0xc8, 0x00, 0x80, 0x20, 0x84, 0x01, 0x26, 0x40, 0x08, 0x64, 0x00, 0x80, 0x2c, 0x80, 0x08, 0x02, 0x38]);
      } else if (channelCount === 5) {
        return new Uint8Array([0x00, 0xc8, 0x00, 0x80, 0x20, 0x84, 0x01, 0x26, 0x40, 0x08, 0x64, 0x00, 0x82, 0x30, 0x04, 0x99, 0x00, 0x21, 0x90, 0x02, 0x38]);
      } else if (channelCount === 6) {
        return new Uint8Array([0x00, 0xc8, 0x00, 0x80, 0x20, 0x84, 0x01, 0x26, 0x40, 0x08, 0x64, 0x00, 0x82, 0x30, 0x04, 0x99, 0x00, 0x21, 0x90, 0x02, 0x00, 0xb2, 0x00, 0x20, 0x08, 0xe0]);
      }
      return null;
    }
  }]);
  return Mp4Remuxer;
}();

export default Mp4Remuxer;
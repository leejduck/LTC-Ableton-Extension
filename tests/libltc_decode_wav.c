/*
 * Independent LTC decoder test harness for generated WAV files.
 *
 * This intentionally uses the vendored libltc decoder rather than any of the
 * extension's TypeScript decoding or encoding code. Its line-oriented output
 * is kept stable so automated tests can assert decoded frame sequences.
 */

#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <ltc.h>

#define SAMPLE_BATCH_SIZE 4096
#define DECODE_QUEUE_SIZE 128
#define TIMECODE_TEXT_SIZE 12

typedef struct {
	uint16_t audio_format;
	uint16_t channels;
	uint32_t sample_rate;
	uint16_t block_align;
	uint16_t bits_per_sample;
	long data_offset;
	uint32_t data_size;
} WavInfo;

static uint16_t read_le16(const unsigned char *bytes) {
	return (uint16_t)bytes[0] | ((uint16_t)bytes[1] << 8);
}

static uint32_t read_le32(const unsigned char *bytes) {
	return (uint32_t)bytes[0]
		| ((uint32_t)bytes[1] << 8)
		| ((uint32_t)bytes[2] << 16)
		| ((uint32_t)bytes[3] << 24);
}

static int read_exact(FILE *file, void *buffer, size_t size) {
	return fread(buffer, 1, size, file) == size;
}

static int seek_to_next_chunk(FILE *file, long payload_offset, uint32_t chunk_size) {
	const uint64_t padded_size = (uint64_t)chunk_size + (uint64_t)(chunk_size & 1U);

	if (payload_offset < 0 || padded_size > (uint64_t)LONG_MAX
			|| (uint64_t)payload_offset > (uint64_t)LONG_MAX - padded_size) {
		return 0;
	}

	return fseek(file, payload_offset + (long)padded_size, SEEK_SET) == 0;
}

static int read_wav_info(FILE *file, WavInfo *info) {
	unsigned char riff_header[12];
	int found_format = 0;
	int found_data = 0;

	memset(info, 0, sizeof(*info));
	info->data_offset = -1;

	if (!read_exact(file, riff_header, sizeof(riff_header))) {
		fprintf(stderr, "error: file is too short to contain a WAV header\n");
		return 0;
	}
	if (memcmp(riff_header, "RIFF", 4) != 0
			|| memcmp(riff_header + 8, "WAVE", 4) != 0) {
		fprintf(stderr, "error: expected a little-endian RIFF/WAVE file\n");
		return 0;
	}

	while (!found_format || !found_data) {
		unsigned char chunk_header[8];
		uint32_t chunk_size;
		long payload_offset;

		if (!read_exact(file, chunk_header, sizeof(chunk_header))) {
			fprintf(stderr, "error: WAV is missing a fmt or data chunk\n");
			return 0;
		}

		chunk_size = read_le32(chunk_header + 4);
		payload_offset = ftell(file);
		if (payload_offset < 0) {
			fprintf(stderr, "error: could not determine WAV chunk position\n");
			return 0;
		}

		if (memcmp(chunk_header, "fmt ", 4) == 0 && !found_format) {
			unsigned char format[16];

			if (chunk_size < sizeof(format)
					|| !read_exact(file, format, sizeof(format))) {
				fprintf(stderr, "error: WAV fmt chunk is truncated\n");
				return 0;
			}

			info->audio_format = read_le16(format);
			info->channels = read_le16(format + 2);
			info->sample_rate = read_le32(format + 4);
			info->block_align = read_le16(format + 12);
			info->bits_per_sample = read_le16(format + 14);
			found_format = 1;
		} else if (memcmp(chunk_header, "data", 4) == 0 && !found_data) {
			info->data_offset = payload_offset;
			info->data_size = chunk_size;
			found_data = 1;
		}

		if (!found_format || !found_data) {
			if (!seek_to_next_chunk(file, payload_offset, chunk_size)) {
				fprintf(stderr, "error: invalid WAV chunk size or offset\n");
				return 0;
			}
		}
	}

	if (info->audio_format != 1) {
		fprintf(stderr, "error: expected integer PCM (format 1), got format %u\n",
			(unsigned int)info->audio_format);
		return 0;
	}
	if (info->channels != 1) {
		fprintf(stderr, "error: expected mono audio, got %u channels\n",
			(unsigned int)info->channels);
		return 0;
	}
	if (info->bits_per_sample != 16 || info->block_align != 2) {
		fprintf(stderr,
			"error: expected 16-bit mono PCM with block alignment 2"
			" (bits=%u, alignment=%u)\n",
			(unsigned int)info->bits_per_sample,
			(unsigned int)info->block_align);
		return 0;
	}
	if (info->sample_rate == 0) {
		fprintf(stderr, "error: WAV sample rate must be greater than zero\n");
		return 0;
	}
	if ((info->data_size & 1U) != 0) {
		fprintf(stderr, "error: 16-bit PCM data chunk has an odd byte count\n");
		return 0;
	}
	if (fseek(file, info->data_offset, SEEK_SET) != 0) {
		fprintf(stderr, "error: could not seek to WAV audio data\n");
		return 0;
	}

	return 1;
}

static void format_timecode(
	char *destination,
	size_t destination_size,
	const SMPTETimecode *timecode
) {
	(void)snprintf(
		destination,
		destination_size,
		"%02u:%02u:%02u:%02u",
		(unsigned int)timecode->hours,
		(unsigned int)timecode->mins,
		(unsigned int)timecode->secs,
		(unsigned int)timecode->frame
	);
}

static void drain_decoder(
	LTCDecoder *decoder,
	uint64_t *frame_count,
	char *first_timecode,
	int *first_df,
	char *last_timecode,
	int *last_df
) {
	LTCFrameExt frame;

	while (ltc_decoder_read(decoder, &frame)) {
		SMPTETimecode timecode;
		char text[TIMECODE_TEXT_SIZE];
		const int drop_frame = frame.ltc.dfbit ? 1 : 0;

		ltc_frame_to_time(&timecode, &frame.ltc, 0);
		format_timecode(text, sizeof(text), &timecode);

		*frame_count += 1;
		if (*frame_count == 1) {
			(void)snprintf(first_timecode, TIMECODE_TEXT_SIZE, "%s", text);
			*first_df = drop_frame;
		}
		(void)snprintf(last_timecode, TIMECODE_TEXT_SIZE, "%s", text);
		*last_df = drop_frame;

		printf(
			"FRAME index=%" PRIu64
			" tc=%s df=%d reverse=%d off_start=%lld off_end=%lld\n",
			*frame_count,
			text,
			drop_frame,
			frame.reverse ? 1 : 0,
			(long long)frame.off_start,
			(long long)frame.off_end
		);
	}
}

static int parse_fps(const char *text, double *fps) {
	char *end = NULL;
	double parsed;

	errno = 0;
	parsed = strtod(text, &end);
	if (errno != 0 || end == text || *end != '\0'
			|| !isfinite(parsed) || parsed <= 0.0) {
		return 0;
	}
	*fps = parsed;
	return 1;
}

int main(int argc, char **argv) {
	FILE *file;
	WavInfo wav;
	double fps;
	double audio_frames_per_video_frame;
	int decoder_apv;
	LTCDecoder *decoder;
	unsigned char raw_samples[SAMPLE_BATCH_SIZE * 2];
	short decoded_samples[SAMPLE_BATCH_SIZE];
	uint32_t bytes_remaining;
	ltc_off_t sample_offset = 0;
	uint64_t frame_count = 0;
	char first_timecode[TIMECODE_TEXT_SIZE] = "";
	char last_timecode[TIMECODE_TEXT_SIZE] = "";
	int first_df = 0;
	int last_df = 0;
	int exit_status = EXIT_SUCCESS;

	_Static_assert(sizeof(short) == 2, "libltc s16 input requires a 16-bit short");

	if (argc != 3) {
		fprintf(stderr, "usage: %s <16-bit-mono-pcm.wav> <fps>\n", argv[0]);
		return EXIT_FAILURE;
	}
	if (!parse_fps(argv[2], &fps)) {
		fprintf(stderr, "error: fps must be a positive finite number\n");
		return EXIT_FAILURE;
	}

	file = fopen(argv[1], "rb");
	if (file == NULL) {
		fprintf(stderr, "error: could not open '%s': %s\n", argv[1], strerror(errno));
		return EXIT_FAILURE;
	}
	if (!read_wav_info(file, &wav)) {
		fclose(file);
		return EXIT_FAILURE;
	}

	audio_frames_per_video_frame = (double)wav.sample_rate / fps;
	if (!isfinite(audio_frames_per_video_frame)
			|| audio_frames_per_video_frame < 1.0
			|| audio_frames_per_video_frame > (double)INT_MAX) {
		fprintf(stderr, "error: sample rate and fps produce an invalid decoder period\n");
		fclose(file);
		return EXIT_FAILURE;
	}
	decoder_apv = (int)lround(audio_frames_per_video_frame);
	decoder = ltc_decoder_create(decoder_apv, DECODE_QUEUE_SIZE);
	if (decoder == NULL) {
		fprintf(stderr, "error: libltc could not create a decoder\n");
		fclose(file);
		return EXIT_FAILURE;
	}

	printf(
		"INPUT sample_rate=%" PRIu32
		" channels=%u bits_per_sample=%u samples=%" PRIu32
		" fps=%.6f apv=%d\n",
		wav.sample_rate,
		(unsigned int)wav.channels,
		(unsigned int)wav.bits_per_sample,
		wav.data_size / 2,
		fps,
		decoder_apv
	);

	bytes_remaining = wav.data_size;
	while (bytes_remaining > 0) {
		const size_t requested = bytes_remaining < sizeof(raw_samples)
			? (size_t)bytes_remaining
			: sizeof(raw_samples);
		size_t bytes_read;
		size_t sample_count;
		size_t index;

		bytes_read = fread(raw_samples, 1, requested, file);
		if (bytes_read != requested) {
			fprintf(stderr, "error: WAV data chunk is truncated\n");
			exit_status = EXIT_FAILURE;
			break;
		}

		sample_count = bytes_read / 2;
		for (index = 0; index < sample_count; ++index) {
			const uint16_t value = read_le16(raw_samples + index * 2);
			decoded_samples[index] = (short)(int16_t)value;
		}

		ltc_decoder_write_s16(decoder, decoded_samples, sample_count, sample_offset);
		drain_decoder(
			decoder,
			&frame_count,
			first_timecode,
			&first_df,
			last_timecode,
			&last_df
		);

		bytes_remaining -= (uint32_t)bytes_read;
		sample_offset += (ltc_off_t)sample_count;
	}

	if (exit_status == EXIT_SUCCESS) {
		drain_decoder(
			decoder,
			&frame_count,
			first_timecode,
			&first_df,
			last_timecode,
			&last_df
		);
		if (frame_count == 0) {
			printf(
				"SUMMARY count=0 first=NONE first_df=-"
				" last=NONE last_df=-\n"
			);
		} else {
			printf(
				"SUMMARY count=%" PRIu64
				" first=%s first_df=%d last=%s last_df=%d\n",
				frame_count,
				first_timecode,
				first_df,
				last_timecode,
				last_df
			);
		}
	}

	ltc_decoder_free(decoder);
	fclose(file);
	return exit_status;
}

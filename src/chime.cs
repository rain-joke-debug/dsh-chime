// DSH Chime - the player.
//
// Synthesizes a short tone sequence in memory and plays it through the Windows
// sound stack. No audio files to ship, no Console window (built /target:winexe),
// no dependency beyond the .NET Framework that Windows already has.
//
//   chime.exe ding   [volume]     soft marimba      - a normal answer finished  (default)
//   chime.exe drop   [volume]     water drop        - the quieter alternative
//   chime.exe warm   [volume]     same as ding      - kept so old notes stay true
//   chime.exe alert  [volume]     three rising notes- the agent is waiting for you
//   chime.exe sad    [volume]     two notes down    - the turn died
//   chime.exe test   [volume]     rising arpeggio   - manual check
//   chime.exe dump <dir> [volume]                   - write every wav, play nothing
//
// `volume` is a percentage: 100 is the level this was tuned at, 0 is silent,
// above ~130 starts to clip on the loudest partials. Anything unparseable falls
// back to 100, because a reminder that goes silent is worse than a loud one.
//
// Everything is a struck-and-decaying tone: a fast swell, then an exponential
// fade, with the upper partials dying faster than the fundamental. That shape is
// what makes a chime sound soft instead of like a beeper; a flat note with a
// hard cut at the end can only ever sound like a test signal.
//
// C# 5 only: this is compiled by the csc.exe that ships with Windows.

using System;
using System.Globalization;
using System.IO;
using System.Media;
using System.Text;

internal static class Chime
{
    private const int Rate = 22050;

    /// <summary>Loudness at volume=100. Deliberately low: this fires at every answer.</summary>
    private const double BaseGain = 0.30;

    /// <summary>One struck tone: pitch, how fast it fades, how long, how loud.</summary>
    private sealed class Note
    {
        public readonly double Freq;
        public readonly double Tau;
        public readonly int Ms;
        public readonly double Amp;

        public Note(double freq, double tau, int ms, double amp)
        {
            Freq = freq;
            Tau = tau;
            Ms = ms;
            Amp = amp;
        }
    }

    private static int Main(string[] args)
    {
        string kind = args.Length > 0 ? args[0] : "ding";

        if (kind == "dump")
        {
            string dir = args.Length > 1 ? args[1] : ".";
            double scale = ParseVolume(args.Length > 2 ? args[2] : null);
            Write(Path.Combine(dir, "ding.wav"), Build(Motif("ding"), scale));
            Write(Path.Combine(dir, "drop.wav"), BuildDrop(scale));
            Write(Path.Combine(dir, "alert.wav"), Build(Motif("alert"), scale));
            Write(Path.Combine(dir, "sad.wav"), Build(Motif("sad"), scale));
            return 0;
        }

        double gain = ParseVolume(args.Length > 1 ? args[1] : null);
        byte[] wav = kind == "drop" ? BuildDrop(gain) : Build(Motif(kind), gain);
        try
        {
            using (MemoryStream stream = new MemoryStream(wav))
            {
                using (SoundPlayer player = new SoundPlayer(stream))
                {
                    player.PlaySync();
                }
            }
        }
        catch (Exception)
        {
            // A machine with no audio device must not turn into a crash loop.
            return 1;
        }
        return 0;
    }

    // "60", "60%" and " 60 " all mean 60 percent. Returns a gain multiplier.
    private static double ParseVolume(string text)
    {
        if (text == null) return 1.0;
        text = text.Trim();
        if (text.EndsWith("%")) text = text.Substring(0, text.Length - 1).Trim();
        if (text.Length == 0) return 1.0;

        double percent;
        if (!double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out percent))
        {
            return 1.0;
        }
        if (percent < 0.0) percent = 0.0;
        if (percent > 300.0) percent = 300.0;
        return percent / 100.0;
    }

    // Each motif is a few struck notes. Frequencies are equal temperament;
    // the intervals are consonant thirds and fourths, never a bare semitone.
    private static Note[] Motif(string kind)
    {
        if (kind == "alert")
        {
            return new Note[]
            {
                new Note(659.25, 0.10, 300, 1.00),   // E5
                new Note(830.61, 0.10, 300, 0.95),   // G#5
                new Note(987.77, 0.14, 420, 1.00),   // B5
            };
        }
        if (kind == "sad")
        {
            return new Note[]
            {
                new Note(440.00, 0.16, 480, 1.00),   // A4
                new Note(329.63, 0.20, 620, 0.95),   // E4
            };
        }
        if (kind == "test")
        {
            return new Note[]
            {
                new Note(587.33, 0.12, 320, 1.00),
                new Note(739.99, 0.12, 320, 1.00),
                new Note(880.00, 0.16, 460, 1.00),
            };
        }
        // "ding" and "warm": the soft marimba, a fourth up.
        // A bell (D5->A5) is one edit away if this ever gets tiring.
        return new Note[]
        {
            new Note(349.23, 0.11, 340, 1.00),       // F4
            new Note(523.25, 0.15, 440, 0.95),       // C5
        };
    }

    // A struck tone: swell in, exponential fade out, partials dying faster than
    // the fundamental.
    private static byte[] Build(Note[] notes, double gain)
    {
        int total = 0;
        int[] start = new int[notes.Length];
        int[] len = new int[notes.Length];
        for (int n = 0; n < notes.Length; n++)
        {
            start[n] = total;
            len[n] = Rate * notes[n].Ms / 1000;
            if (len[n] < 1) len[n] = 1;
            total += len[n];
        }

        short[] samples = new short[total];
        for (int n = 0; n < notes.Length; n++)
        {
            Note note = notes[n];
            int count = len[n];
            int attack = Rate * 14 / 1000;   // 14 ms swell, no click
            int release = Rate * 30 / 1000;  // 30 ms fade to true zero, no click
            if (attack < 1) attack = 1;
            if (release < 1) release = 1;

            for (int i = 0; i < count; i++)
            {
                double t = (double)i / Rate;

                // Partial 1 rings out, 2 and 3 fade away sooner: bell, not buzz.
                double v = Math.Exp(-t / note.Tau) * Math.Sin(2 * Math.PI * note.Freq * t);
                v += 0.20 * Math.Exp(-t / (note.Tau / 2.2)) * Math.Sin(2 * Math.PI * note.Freq * 2.00 * t);
                v += 0.05 * Math.Exp(-t / (note.Tau / 3.2)) * Math.Sin(2 * Math.PI * note.Freq * 3.01 * t);

                double swell = i < attack ? (double)i / attack : 1.0;
                swell = swell * swell * (3.0 - 2.0 * swell);   // smoothstep

                int tail = count - i;
                double fade = 1.0;
                if (tail < release)
                {
                    fade = (double)tail / release;
                    fade = fade * fade;
                }

                double s = v * swell * fade * note.Amp * BaseGain * gain / 1.25;
                if (s > 1.0) s = 1.0;
                if (s < -1.0) s = -1.0;
                samples[start[n] + i] = (short)(s * 32000);
            }
        }

        return Wrap(samples);
    }

    // The water drop: one blip whose pitch falls fast and then settles.
    private static byte[] BuildDrop(double gain)
    {
        int count = Rate * 260 / 1000;
        short[] samples = new short[count];
        int attack = Rate * 4 / 1000;
        int release = Rate * 30 / 1000;
        const double floor = 640.0;   // where the pitch lands
        const double jump = 780.0;    // how far above it starts
        const double glide = 0.035;   // how fast it falls

        for (int i = 0; i < count; i++)
        {
            double t = (double)i / Rate;
            // Frequency is floor + jump*exp(-t/glide); integrate it for phase
            // so the glide is smooth instead of stepping.
            double phase = 2 * Math.PI * (floor * t + jump * glide * (1 - Math.Exp(-t / glide)));
            double v = Math.Exp(-t / 0.07) * Math.Sin(phase);
            v += 0.12 * Math.Exp(-t / 0.03) * Math.Sin(2 * phase);

            double swell = i < attack ? (double)i / attack : 1.0;
            swell = swell * swell * (3.0 - 2.0 * swell);

            int tail = count - i;
            double fade = 1.0;
            if (tail < release)
            {
                fade = (double)tail / release;
                fade = fade * fade;
            }

            double s = v * swell * fade * BaseGain * gain / 1.12;
            if (s > 1.0) s = 1.0;
            if (s < -1.0) s = -1.0;
            samples[i] = (short)(s * 32000);
        }

        return Wrap(samples);
    }

    // 16-bit mono PCM in a RIFF container.
    private static byte[] Wrap(short[] samples)
    {
        int dataBytes = samples.Length * 2;
        using (MemoryStream stream = new MemoryStream(44 + dataBytes))
        {
            using (BinaryWriter w = new BinaryWriter(stream))
            {
                w.Write(Encoding.ASCII.GetBytes("RIFF"));
                w.Write(36 + dataBytes);
                w.Write(Encoding.ASCII.GetBytes("WAVE"));
                w.Write(Encoding.ASCII.GetBytes("fmt "));
                w.Write(16);            // PCM header size
                w.Write((short)1);      // PCM
                w.Write((short)1);      // mono
                w.Write(Rate);
                w.Write(Rate * 2);      // byte rate
                w.Write((short)2);      // block align
                w.Write((short)16);     // bits per sample
                w.Write(Encoding.ASCII.GetBytes("data"));
                w.Write(dataBytes);
                for (int i = 0; i < samples.Length; i++) w.Write(samples[i]);
                w.Flush();
            }
            return stream.ToArray();
        }
    }

    private static void Write(string path, byte[] wav)
    {
        File.WriteAllBytes(path, wav);
    }
}

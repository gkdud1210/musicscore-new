<?php
/**
 * 아주 작은 PDF 만들기 — 페이지마다 JPEG 그림 1장 + 필기(선) + 곡 책갈피.
 * 카페24에는 프로그램을 설치할 수 없어서 직접 PDF 형식을 써서 바로 내려보낸다.
 */

final class ImagePdf
{
    /** @var array<int, array{jpeg:string, w:float, h:float, strokes:array}> */
    private array $pages = [];
    /** @var array<int, array{title:string, page:int}> */
    private array $bookmarks = [];

    public function addPage(string $jpegPath, float $wPt, float $hPt, array $strokes = []): int
    {
        $this->pages[] = ['jpeg' => $jpegPath, 'w' => $wPt > 0 ? $wPt : 595.0, 'h' => $hPt > 0 ? $hPt : 842.0, 'strokes' => $strokes];
        return count($this->pages) - 1;
    }

    public function addBookmark(string $title, int $pageIndex): void
    {
        $this->bookmarks[] = ['title' => $title, 'page' => $pageIndex];
    }

    public function pageCount(): int { return count($this->pages); }

    /** PDF 를 바로 내려보낸다 (메모리를 아끼려고 한 덩어리씩) */
    public function output(string $filename, bool $download = true): void
    {
        header('Content-Type: application/pdf');
        header('Cache-Control: private, no-store');
        header('Content-Disposition: ' . ($download ? content_disposition($filename) : 'inline'));
        $w = new PdfStream();
        $w->write("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

        $n = count($this->pages);
        // 번호: 1 Catalog, 2 Pages, 3 ExtGState(형광펜), 4 Outlines, 그다음 페이지마다 Page/Contents/Image
        $pageObj = fn($i) => 5 + $i * 3;
        $kids = [];
        for ($i = 0; $i < $n; $i++) $kids[] = $pageObj($i) . ' 0 R';
        $hasOutline = (bool)$this->bookmarks;
        $outlineBase = 5 + $n * 3;

        $w->obj(1, '<< /Type /Catalog /Pages 2 0 R' . ($hasOutline ? ' /Outlines 4 0 R /PageMode /UseOutlines' : '') . ' >>');
        $w->obj(2, '<< /Type /Pages /Kids [' . implode(' ', $kids) . "] /Count $n >>");
        $w->obj(3, '<< /Type /ExtGState /CA 0.35 /ca 0.35 >>');
        if ($hasOutline) {
            $m = count($this->bookmarks);
            $w->obj(4, "<< /Type /Outlines /First $outlineBase 0 R /Last " . ($outlineBase + $m - 1) . " 0 R /Count $m >>");
        } else {
            $w->obj(4, '<< /Type /Outlines /Count 0 >>');
        }

        foreach ($this->pages as $i => $p) {
            $po = $pageObj($i);
            $info = @getimagesize($p['jpeg']);
            if (!$info) throw new ApiError(500, '페이지 그림을 열 수 없어요');
            [$pxW, $pxH] = $info;
            $cs = ($info['channels'] ?? 3) === 1 ? '/DeviceGray' : (($info['channels'] ?? 3) === 4 ? '/DeviceCMYK' : '/DeviceRGB');
            $W = self::num($p['w']);
            $H = self::num($p['h']);
            $content = "q $W 0 0 $H 0 0 cm /Im0 Do Q\n" . self::strokesOps($p['strokes'], $p['w'], $p['h']);
            $w->obj($po, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 $W $H] /Contents " . ($po + 1) . ' 0 R'
                . ' /Resources << /XObject << /Im0 ' . ($po + 2) . ' 0 R >> /ExtGState << /GS1 3 0 R >> >> >>');
            $w->stream($po + 1, '', $content);
            $w->streamFile($po + 2, "/Type /XObject /Subtype /Image /Width $pxW /Height $pxH /ColorSpace $cs /BitsPerComponent 8 /Filter /DCTDecode", $p['jpeg']);
        }

        foreach ($this->bookmarks as $j => $b) {
            $id = $outlineBase + $j;
            $dict = '<< /Title ' . self::text($b['title']) . ' /Parent 4 0 R'
                . ($j > 0 ? ' /Prev ' . ($id - 1) . ' 0 R' : '')
                . ($j < count($this->bookmarks) - 1 ? ' /Next ' . ($id + 1) . ' 0 R' : '')
                . ' /Dest [' . $pageObj(max(0, min($n - 1, $b['page']))) . ' 0 R /Fit] >>';
            $w->obj($id, $dict);
        }
        $w->finish(1);
    }

    private static function num(float $v): string
    {
        return rtrim(rtrim(number_format($v, 3, '.', ''), '0'), '.') ?: '0';
    }

    /** 필기 선: 좌표는 페이지 폭/높이 대비 0~1 (맥 버전과 같은 저장 형식) */
    private static function strokesOps(array $strokes, float $pw, float $ph): string
    {
        $out = '';
        foreach ($strokes as $s) {
            $pts = $s['points'] ?? [];
            if (!is_array($pts) || count($pts) < 2) continue;
            $hex = ltrim((string)($s['color'] ?? '#ff3b30'), '#');
            if (!preg_match('/^[0-9a-fA-F]{6}$/', $hex)) $hex = 'ff3b30';
            $rgb = array_map(fn($k) => self::num(hexdec(substr($hex, $k, 2)) / 255), [0, 2, 4]);
            $lw = max((float)($s['width_ratio'] ?? 0.004) * $pw, 0.5);
            $out .= 'q ' . (($s['tool'] ?? '') === 'highlighter' ? '/GS1 gs ' : '')
                . implode(' ', $rgb) . ' RG ' . self::num($lw) . " w 1 J 1 j\n";
            foreach ($pts as $k => $pt) {
                $x = self::num((float)($pt[0] ?? 0) * $pw);
                $y = self::num($ph - (float)($pt[1] ?? 0) * $ph);
                $out .= "$x $y " . ($k === 0 ? 'm' : 'l') . "\n";
            }
            $out .= "S Q\n";
        }
        return $out;
    }

    /** 책갈피 글자: UTF-16BE 16진수 */
    private static function text(string $s): string
    {
        return '<FEFF' . strtoupper(bin2hex(mb_convert_encoding($s, 'UTF-16BE', 'UTF-8'))) . '>';
    }
}

final class PdfStream
{
    private int $offset = 0;
    private array $xref = [];

    public function write(string $s): void
    {
        echo $s;
        $this->offset += strlen($s);
    }

    public function obj(int $id, string $body): void
    {
        $this->xref[$id] = $this->offset;
        $this->write("$id 0 obj\n$body\nendobj\n");
    }

    public function stream(int $id, string $dict, string $data): void
    {
        $this->xref[$id] = $this->offset;
        $this->write("$id 0 obj\n<< $dict /Length " . strlen($data) . " >>\nstream\n");
        $this->write($data);
        $this->write("\nendstream\nendobj\n");
    }

    public function streamFile(int $id, string $dict, string $path): void
    {
        $size = filesize($path);
        $this->xref[$id] = $this->offset;
        $this->write("$id 0 obj\n<< $dict /Length $size >>\nstream\n");
        $fh = fopen($path, 'rb');
        while (!feof($fh)) {
            $chunk = fread($fh, 65536);
            if ($chunk === false) break;
            $this->write($chunk);
        }
        fclose($fh);
        $this->write("\nendstream\nendobj\n");
    }

    public function finish(int $rootId): void
    {
        $max = $this->xref ? max(array_keys($this->xref)) : 0;
        $start = $this->offset;
        $x = "xref\n0 " . ($max + 1) . "\n0000000000 65535 f \n";
        for ($i = 1; $i <= $max; $i++) {
            $x .= isset($this->xref[$i]) ? sprintf("%010d 00000 n \n", $this->xref[$i]) : "0000000000 65535 f \n";
        }
        $this->write($x . "trailer\n<< /Size " . ($max + 1) . " /Root $rootId 0 R >>\nstartxref\n$start\n%%EOF\n");
    }
}

<?php
namespace App\Controllers;

final class Spike extends BaseController
{
    public function index()
    {
        $text = (string) $this->request->getBody();
        if (strlen($text) > 8192) {
            return $this->response->setStatusCode(413)->setJSON(['error' => 'body_too_large']);
        }
        try {
            $body = $text === '' ? new \stdClass() : json_decode($text, false, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException $e) {
            return $this->response->setStatusCode(422)->setJSON(['error' => 'invalid_json']);
        }
        try {
            $db = \Config\Database::connect();
            $row = $db->query('SELECT * FROM api_call(?,?,?,?,?::jsonb)', [
                strtoupper($this->request->getMethod()),
                '/' . ltrim($this->request->getUri()->getRoutePath(), '/'),
                $this->request->getHeaderLine('Authorization'),
                $this->request->getHeaderLine('Idempotency-Key'),
                json_encode($body, JSON_THROW_ON_ERROR),
            ])->getRowArray();
            return $this->response->setHeader('Cache-Control', 'no-store')
                ->setStatusCode((int) $row['http_status'])
                ->setJSON(json_decode($row['payload'], true, 512, JSON_THROW_ON_ERROR));
        } catch (\Throwable $e) {
            // Diagnóstico del adaptador sin mensajes SQL, tokens ni payloads.
            error_log('F01 adapter: ' . get_class($e) . ' ' . basename($e->getFile()) . ':' . $e->getLine());
            return $this->response->setStatusCode(500)->setJSON(['error' => 'internal_error']);
        }
    }
}

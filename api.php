<?php
declare(strict_types=1);

require __DIR__ . '/src/bootstrap.php';
require __DIR__ . '/src/GameService.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Allow: POST');
    api_error('Použij metodu POST.', 405);
}

try {
    $service = new GameService(db());
    json_response($service->handle(json_input()));
} catch (JsonException) {
    api_error('Požadavek nemá platný JSON.', 400);
} catch (DomainException $error) {
    $status = $error->getCode();
    api_error($error->getMessage(), $status >= 400 && $status <= 599 ? $status : 400);
} catch (PDOException $error) {
    error_log($error->__toString());
    api_error('Databáze momentálně není dostupná.', 503);
} catch (Throwable $error) {
    error_log($error->__toString());
    api_error('Něco se nepovedlo. Zkus to prosím znovu.', 500);
}
